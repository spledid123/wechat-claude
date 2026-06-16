# Feature 03: 文件/图片预处理（OCR + markitdown）

> 状态：✅ 已完成  |  测试：7/7 文件通过  |  日期：2026-06-15

---

## 一、功能概述

微信用户发送的图片和文件不能直接扔给 Claude Code——需要先提取文字内容，组装成提示词再传给 AI。

| 文件类型 | 处理工具 | 输出 |
|---------|---------|------|
| `.png .jpg .gif .bmp .webp` | PaddleOCR (ONNX) | 中文/英文识别文字 |
| `.pdf .docx .xlsx .pptx` | markitdown | Markdown 文本 |
| `.txt .m .py .csv .json` 等 | 直接读取 | 原始文本 |
| 其他 | 跳过 | 告知 AI 不支持 |

**原则：预处理失败不阻断流程，告诉 AI 收到了什么、处理结果如何，让 AI 决定怎么回用户。**

---

## 二、怎么用

### 2.1 命令行（手动测试）

```bash
# OCR 识别图片
.venv\Scripts\python scripts\preprocess.py --mode ocr --file test/pic/photo.png

# 文档转文本
.venv\Scripts\python scripts\preprocess.py --mode markitdown --file test/pic/report.pdf

# 批量测试所有文件
npx tsx scripts\preprocess-test.ts
```

输出格式（JSON）：
```json
{"ok": true, "text": "识别的文字内容..."}
{"ok": false, "error": "OCR 无法识别文字"}
```

### 2.2 TypeScript 调用（代码中）

```typescript
import { FilePreprocessor } from "./test/features/03-file-preprocessing/preprocessor.js";

const pp = new FilePreprocessor();

// 处理单个文件
const result = await pp.process("test/pic/photo.png");
// → { extractedText: "...", mimeType: "image/png", error: null }

// 批量处理
const results = await pp.processAll(["a.png", "b.pdf", "c.docx"]);
```

### 2.3 与 Claude 对话集成

预处理结果注入 `PromptContext.files`，Feature 1 的 prompt-builder 自动组装：

```typescript
const ctx: PromptContext = {
  userText: "帮我分析这个文件",
  files: [
    {
      name: "实验.docx",
      path: "/workspace/incoming/实验.docx",
      extractedText: preprocessResult.extractedText,
      mimeType: preprocessResult.mimeType,
    },
  ],
};
// buildSystemPromptAppend(ctx) 自动生成：
//   Files received from WeChat:
//     - 实验.docx (Word 文档) — text extracted, 1567 chars
//
// buildUserMessage(ctx) 把文件内容内联到用户消息
```

---

## 三、文件路由规则

```
扩展名                     → 模式           → 工具
──────────────────────────────────────────────────
.png .jpg .jpeg .gif
  .bmp .webp              → ocr            → PaddleOCR (ONNX Runtime)
.pdf                       → markitdown     → markitdown (pdfminer-six)
.docx .doc                 → markitdown     → markitdown (mammoth)
.xlsx .xls                 → markitdown     → markitdown (openpyxl)
.pptx .ppt                 → markitdown     → markitdown (python-pptx)
.txt .m .py .js .ts .json
  .csv .xml .html .css .md
  .yml .yaml .sh .c .cpp
  .h .java .rs .go .rb
  .php .sql .log           → text           → fs.readFileSync (UTF-8/GBK/Latin-1 fallback)
其他                       → unsupported    → 跳过，告知 AI
```

---

## 四、失败处理

| 场景 | 预处理内部 | `PromptContext.files` 中 |
|------|-----------|------------------------|
| OCR 成功 | 提取文字 | `extractedText: "..."` |
| OCR 超时 (60s) | 重试 1 次 → 放弃 | `preprocessingError: "OCR 超时"` |
| OCR 返回空 | 重试 1 次 → 放弃 | `preprocessingError: "OCR 无法识别文字"` |
| markitdown 失败 | 直接放弃 | `preprocessingError: "文件转换失败"` |
| 工具未安装 | 直接跳过 | `preprocessingError: "工具未安装"` |
| 不支持的类型 | 直接跳过 | `preprocessingError: "不支持此文件类型"` |
| 文本 >50000 字 | 截断 | `extractedText: "..." (truncated)` |

AI 看到 `preprocessingError` 后自行回复用户，例如：
- "你发的 photo.jpg 我看不清，能描述一下吗？"
- "data.bin 我不认识，这是什么文件？"

**约束 AI 不自行处理文件**（在 `buildSystemPromptAppend` 中注入）：
```
Do NOT try to read or process raw files (PDF, DOCX, images, etc.) yourself.
File contents are already extracted and provided above. If extraction failed
(⚠️ marker), tell the user — do not attempt to fix it with Bash.
```

---

## 五、技术细节

### 5.1 PaddleOCR 选型

| 方案 | CPU 速度 | 中文准确率 | 内存 |
|------|---------|-----------|------|
| PaddleOCR ONNX (选用) | 10-30s/图 | >95% | ~500MB |
| Tesseract | 0.5s/图 | ~80% | ~200MB |

选用 PaddleOCR + ONNX Runtime 后端，原因：
- 中文准确率远超 Tesseract
- ONNX 后端绕过 Windows + oneDNN 兼容性 bug
- 大图自动缩放到 4000px 限制内存

### 5.2 PaddleOCR 3.7 特殊处理

```python
# ✅ 正确用法
ocr = PaddleOCR(lang="ch", engine="onnxruntime")
result = ocr.predict("image.png")
# rec_texts 不在属性上，需通过 save_to_json 获取
page.save_to_json("tmp.json")
texts = json.load(open("tmp.json"))["rec_texts"]

# ❌ 错误用法（oneDNN crash）
ocr = PaddleOCR(lang="ch")  # 默认 paddle 引擎

# ❌ 错误用法（属性不存在）
texts = page.rec_texts  # None!
```

### 5.3 markitdown

```python
from markitdown import MarkItDown
md = MarkItDown()
result = md.convert("file.pdf")
text = result.text_content  # Markdown 格式文本
```

需要 `markitdown[all]` 安装所有可选依赖（pdfminer, mammoth, openpyxl 等）。

### 5.4 Python 环境

```bash
python -m venv .venv
.venv\Scripts\pip install "markitdown[all]" paddleocr paddlepaddle
```

首次运行 PaddleOCR 会自动从 modelscope 下载 ONNX 模型（约 170MB）。

---

## 六、实测结果

```
文件                                    工具           字数      耗时
──────────────────────────────────────────────────────────────────
1-s2.0-...pdf     (2.1MB)            markitdown    50,000    4s
84fd9ff5-...png   (93KB, 英文网页)   PaddleOCR       943    12s
b68e137c-...png   (13KB, 游戏截图)   PaddleOCR        42    10s
DSC05621.JPG      (11.5MB, 照片)     PaddleOCR        68    27s
实验.docx          (619KB)            markitdown     1,567    3s
工作簿1.xlsx       (11KB)             markitdown     1,450    3s
compute_...m      (26KB)             直接读取      26,665    0s
```

---

## 七、文件清单

```
.venv/                                    ← Python venv (paddleocr + markitdown)
scripts/
├── preprocess.py                         ← Python 预处理入口 (ocr/markitdown/text)
└── preprocess-test.ts                    ← 批量测试脚本
test/features/03-file-preprocessing/
├── README.md                             ← 本文档
├── preprocessor.ts                       ← TypeScript 预处理模块
└── feature-03.test.ts                    ← 单元测试
```
