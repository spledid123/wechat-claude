#!/usr/bin/env python
"""Preprocess WeChat attachments for WeChat Claude.

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
import tempfile
from pathlib import Path
from typing import Any

MAX_CHARS = int(os.environ.get("WECHAT_CLAUDE_PREPROCESS_MAX_CHARS", "50000"))
ORIGINAL_STDOUT = sys.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["ocr", "markitdown", "text"], required=True)
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        write_json({"ok": False, "error": "文件不存在"})
        return

    try:
        if args.mode == "text":
            result = preprocess_text(file_path)
        elif args.mode == "markitdown":
            result = preprocess_markitdown(file_path)
        else:
            result = preprocess_ocr(file_path)
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
        return {"ok": False, "error": "文档未提取到文本；扫描版 PDF 可能需要先转图片 OCR"}
    return ok_text(text)


def preprocess_ocr(file_path: Path) -> dict[str, Any]:
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from paddleocr import PaddleOCR
    except ImportError:
        return {"ok": False, "error": "paddleocr 未安装。请安装 Python 预处理依赖：pip install paddleocr paddlepaddle"}

    with contextlib.redirect_stdout(sys.stderr):
        ocr = create_paddle_ocr(PaddleOCR)
        raw_result = run_paddle_ocr(ocr, file_path)

    texts = extract_ocr_texts(raw_result)
    text = "\n".join(dedupe_keep_order(texts)).strip()
    if not text:
        return {"ok": False, "error": "OCR 未识别到文字"}
    return ok_text(text)


def create_paddle_ocr(paddle_ocr_cls: Any) -> Any:
    attempts = [
        lambda: paddle_ocr_cls(lang="ch", engine="onnxruntime"),
        lambda: paddle_ocr_cls(lang="ch", use_angle_cls=True),
        lambda: paddle_ocr_cls(lang="ch"),
    ]
    last_error: Exception | None = None
    for attempt in attempts:
        try:
            return attempt()
        except Exception as exc:  # noqa: BLE001 - compatibility probing
            last_error = exc
    raise RuntimeError(f"PaddleOCR 初始化失败: {last_error}")


def run_paddle_ocr(ocr: Any, file_path: Path) -> Any:
    if hasattr(ocr, "predict"):
        return ocr.predict(str(file_path))
    if hasattr(ocr, "ocr"):
        try:
            return ocr.ocr(str(file_path), cls=True)
        except TypeError:
            return ocr.ocr(str(file_path))
    raise RuntimeError("当前 PaddleOCR 对象不支持 predict/ocr")


def extract_ocr_texts(value: Any) -> list[str]:
    texts: list[str] = []
    seen_objects: set[int] = set()

    def visit(obj: Any) -> None:
      obj_id = id(obj)
      if obj_id in seen_objects:
          return
      seen_objects.add(obj_id)

      if obj is None:
          return

      if isinstance(obj, dict):
          rec_texts = obj.get("rec_texts")
          if isinstance(rec_texts, list):
              texts.extend(str(item) for item in rec_texts if str(item).strip())
          for key in ("text", "transcription"):
              item = obj.get(key)
              if isinstance(item, str) and item.strip():
                  texts.append(item)
          for item in obj.values():
              visit(item)
          return

      if isinstance(obj, (list, tuple)):
          if len(obj) >= 2 and isinstance(obj[1], (list, tuple)) and obj[1]:
              maybe_text = obj[1][0]
              if isinstance(maybe_text, str) and maybe_text.strip():
                  texts.append(maybe_text)
          for item in obj:
              visit(item)
          return

      for attr in ("rec_texts", "texts", "text"):
          try:
              item = getattr(obj, attr)
          except Exception:  # noqa: BLE001 - third-party object
              continue
          if isinstance(item, list):
              texts.extend(str(part) for part in item if str(part).strip())
          elif isinstance(item, str) and item.strip():
              texts.append(item)

      if hasattr(obj, "save_to_json"):
          try:
              with tempfile.TemporaryDirectory() as tmpdir:
                  json_path = Path(tmpdir) / "ocr.json"
                  obj.save_to_json(str(json_path))
                  if json_path.exists():
                      visit(json.loads(json_path.read_text(encoding="utf-8")))
          except Exception:
              pass

      try:
          obj_dict = getattr(obj, "__dict__", None)
          if isinstance(obj_dict, dict):
              visit(obj_dict)
      except Exception:
          pass

    visit(value)
    return texts


def dedupe_keep_order(items: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        normalized = " ".join(str(item).split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def ok_text(text: str) -> dict[str, Any]:
    truncated = len(text) > MAX_CHARS
    return {"ok": True, "text": text[:MAX_CHARS], "truncated": truncated}


def write_json(payload: dict[str, Any]) -> None:
    json.dump(payload, ORIGINAL_STDOUT, ensure_ascii=False)
    ORIGINAL_STDOUT.write("\n")
    ORIGINAL_STDOUT.flush()


if __name__ == "__main__":
    main()
