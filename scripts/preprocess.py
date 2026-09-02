#!/usr/bin/env python
"""Preprocess WeChat attachments for WeChat Claude.

Images are handled by the vision model in TypeScript (see vision.ts) — this
script only serves document conversion (markitdown) for PDF/Office files,
plus PDF page rendering for the scanned-PDF vision fallback.

Outputs one JSON object to stdout:
  {"ok": true, "text": "...", "truncated": false, "pages": 12, "chars_per_page": 830.0}
  {"ok": true, "total": 35, "rendered": 20, "start": 1, "pages": ["...png"]}
  {"ok": false, "error": "...", "pages": 35}

Third-party libraries can be noisy, so imports and conversions redirect stdout
to stderr. The TypeScript caller reads the final JSON object from stdout.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path
from typing import Any

MAX_CHARS = int(os.environ.get("WECHAT_CLAUDE_PREPROCESS_MAX_CHARS", "50000"))
RENDER_DPI = 150
# Embedded-image extraction: skip icons/decorations below this size, and cap
# one call so an image-heavy PDF cannot explode the workspace.
MIN_IMAGE_DIM = 100
MAX_IMAGES_PER_CALL = 40
ORIGINAL_STDOUT = sys.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["markitdown", "text", "pdf-pages", "pdf-images"], required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--out-dir")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--max-pages", type=int, default=20)
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        write_json({"ok": False, "error": "文件不存在"})
        return

    try:
        if args.mode == "text":
            result = preprocess_text(file_path)
        elif args.mode == "pdf-pages":
            result = render_pdf_pages(file_path, args)
        elif args.mode == "pdf-images":
            result = extract_pdf_images(file_path, args)
        else:
            result = preprocess_markitdown(file_path)
    except Exception as exc:  # noqa: BLE001 - user-facing boundary
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        pages = pdf_page_count(file_path)
        if pages is not None:
            result["pages"] = pages

    write_json(result)


def preprocess_text(file_path: Path) -> dict[str, Any]:
    for encoding in ("utf-8", "gbk", "latin1"):
        try:
            text = file_path.read_text(encoding=encoding)
            if text.strip():
                return ok_text(text)
        except UnicodeDecodeError:
            continue
    return {"ok": False, "error": "无法解码文件编码"}


def _pymupdf():
    """PyMuPDF handle; the old `fitz` import name is deprecated."""
    with contextlib.redirect_stdout(sys.stderr):
        try:
            import pymupdf
            return pymupdf
        except ImportError:
            import fitz
            return fitz


def pdf_page_count(file_path: Path) -> int | None:
    """Page count via PyMuPDF; None when the lib is missing or file unreadable."""
    try:
        pymupdf = _pymupdf()
    except ImportError:
        return None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            with pymupdf.open(file_path) as doc:
                return doc.page_count
    except Exception:  # noqa: BLE001 - any failure means "no page info"
        return None


def preprocess_markitdown(file_path: Path) -> dict[str, Any]:
    pages = pdf_page_count(file_path) if file_path.suffix.lower() == ".pdf" else None

    try:
        with contextlib.redirect_stdout(sys.stderr):
            from markitdown import MarkItDown
    except ImportError:
        return {"ok": False, "error": "markitdown 未安装。请安装 Python 预处理依赖：pip install \"markitdown[all]\""}

    with contextlib.redirect_stdout(sys.stderr):
        converter = MarkItDown()
        result = converter.convert(str(file_path))

    text = getattr(result, "text_content", None) or str(result)
    if not text or not text.strip():
        payload: dict[str, Any] = {
            "ok": False,
            "error": "文档未提取到文本；扫描版 PDF 会走视觉识别回退",
        }
        if pages is not None:
            payload["pages"] = pages
            payload["chars_per_page"] = 0.0
        return payload

    payload = ok_text(text)
    if pages:
        payload["pages"] = pages
        payload["chars_per_page"] = len(text) / pages
    return payload


def render_pdf_pages(file_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    if not args.out_dir:
        return {"ok": False, "error": "pdf-pages 模式需要 --out-dir"}

    try:
        pymupdf = _pymupdf()
    except ImportError:
        return {
            "ok": False,
            "error": "pymupdf 未安装。请安装：pip install pymupdf",
        }

    start = max(1, args.start)
    zoom = RENDER_DPI / 72.0
    matrix = pymupdf.Matrix(zoom, zoom)

    with contextlib.redirect_stdout(sys.stderr):
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        with pymupdf.open(file_path) as doc:
            total = doc.page_count
            first_index = min(start - 1, max(total - 1, 0))
            last_index = min(first_index + max(args.max_pages, 0), total)
            paths: list[str] = []
            for index in range(first_index, last_index):
                pixmap = doc[index].get_pixmap(matrix=matrix)
                out_path = out_dir / f"page-{index + 1:04d}.png"
                pixmap.save(str(out_path))
                paths.append(str(out_path))

    return {
        "ok": True,
        "total": total,
        "start": first_index + 1,
        "rendered": len(paths),
        "pages": paths,
    }


def extract_pdf_images(file_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    """Extract original embedded images (figures) from the given PDF pages.

    Keeps original bytes (JPEG stays JPEG); skips images smaller than
    MIN_IMAGE_DIM (icons/dividers), dedupes repeated xrefs (logos), and caps
    the output at MAX_IMAGES_PER_CALL files.
    """
    if not args.out_dir:
        return {"ok": False, "error": "pdf-images 模式需要 --out-dir"}

    try:
        pymupdf = _pymupdf()
    except ImportError:
        return {"ok": False, "error": "pymupdf 未安装。请安装：pip install pymupdf"}

    with contextlib.redirect_stdout(sys.stderr):
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        with pymupdf.open(file_path) as doc:
            total = doc.page_count
            first_index = min(max(1, args.start) - 1, max(total - 1, 0))
            last_index = min(first_index + max(args.max_pages, 0), total)
            paths: list[str] = []
            skipped = 0
            seen_xrefs: set[int] = set()
            for page_index in range(first_index, last_index):
                for img in doc[page_index].get_images(full=True):
                    xref, width, height = img[0], img[2], img[3]
                    if xref in seen_xrefs:
                        continue
                    seen_xrefs.add(xref)
                    if width < MIN_IMAGE_DIM or height < MIN_IMAGE_DIM:
                        skipped += 1
                        continue
                    if len(paths) >= MAX_IMAGES_PER_CALL:
                        skipped += 1
                        continue
                    try:
                        info = doc.extract_image(xref)
                    except Exception:  # noqa: BLE001 - corrupt/stenciled image
                        skipped += 1
                        continue
                    ext = info.get("ext") or "png"
                    out_path = out_dir / f"p{page_index + 1:04d}-img{len(paths) + 1:02d}.{ext}"
                    out_path.write_bytes(info["image"])
                    paths.append(str(out_path))

    return {
        "ok": True,
        "total": total,
        "start": first_index + 1,
        "images": paths,
        "skipped": skipped,
    }


def ok_text(text: str) -> dict[str, Any]:
    truncated = len(text) > MAX_CHARS
    return {"ok": True, "text": text[:MAX_CHARS], "truncated": truncated}


def write_json(payload: dict[str, Any]) -> None:
    json.dump(payload, ORIGINAL_STDOUT, ensure_ascii=False)
    ORIGINAL_STDOUT.write("\n")
    ORIGINAL_STDOUT.flush()


if __name__ == "__main__":
    main()
