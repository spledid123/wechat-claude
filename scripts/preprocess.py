#!/usr/bin/env python
"""Preprocess WeChat attachments for WeChat Claude.

Images are handled by the vision model in TypeScript (see vision.ts) — this
script only serves document conversion (markitdown) for PDF/Office files.

Outputs one JSON object to stdout:
  {"ok": true, "text": "...", "truncated": false}
  {"ok": false, "error": "..."}

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
ORIGINAL_STDOUT = sys.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["markitdown", "text"], required=True)
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        write_json({"ok": False, "error": "文件不存在"})
        return

    try:
        if args.mode == "text":
            result = preprocess_text(file_path)
        else:
            result = preprocess_markitdown(file_path)
    except Exception as exc:  # noqa: BLE001 - user-facing boundary
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

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


def preprocess_markitdown(file_path: Path) -> dict[str, Any]:
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
        return {"ok": False, "error": "文档未提取到文本；扫描版 PDF 可能需要先转图片"}
    return ok_text(text)


def ok_text(text: str) -> dict[str, Any]:
    truncated = len(text) > MAX_CHARS
    return {"ok": True, "text": text[:MAX_CHARS], "truncated": truncated}


def write_json(payload: dict[str, Any]) -> None:
    json.dump(payload, ORIGINAL_STDOUT, ensure_ascii=False)
    ORIGINAL_STDOUT.write("\n")
    ORIGINAL_STDOUT.flush()


if __name__ == "__main__":
    main()
