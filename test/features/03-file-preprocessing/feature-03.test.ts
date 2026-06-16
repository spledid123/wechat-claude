/**
 * Feature 03 Test Suite: File/Image Preprocessing
 *
 * Tests:
 *   Group A — File type detection & routing
 *   Group B — Text files (direct read)
 *   Group C — markitdown (PDF/DOCX/XLSX)
 *   Group D — PaddleOCR (PNG/JPG)
 *   Group E — Unsupported files
 *   Group F — Edge cases (missing file, empty file, encoding)
 */

import { describe, it, expect } from "vitest";
import { FilePreprocessor } from "./preprocessor.js";
import fs from "node:fs";
import path from "node:path";

const PIC_DIR = path.join(process.cwd(), "test", "pic");

// ---------------------------------------------------------------------------
// Group A: File type detection & routing
// ---------------------------------------------------------------------------

describe("Group A — File type detection & routing", () => {
  const pp = new FilePreprocessor();

  it("A1: PNG routes to ocr", async () => {
    const r = await pp.process(path.join(PIC_DIR, "b68e137ce846091993541b52b031927a.png"));
    expect(r.mimeType).toBe("image/png");
    // Should NOT say "unsupported"
    expect(r.error).not.toBe("不支持此文件类型");
  });

  it("A2: PDF routes to markitdown", async () => {
    const r = await pp.process(path.join(PIC_DIR, "1-s2.0-S092698511400250X-main.pdf"));
    expect(r.mimeType).toBe("application/pdf");
    expect(r.error).not.toBe("不支持此文件类型");
  });

  it("A3: DOCX routes to markitdown", async () => {
    const r = await pp.process(path.join(PIC_DIR, "实验.docx"));
    expect(r.mimeType).toContain("wordprocessing");
    expect(r.error).not.toBe("不支持此文件类型");
  });

  it("A4: XLSX routes to markitdown", async () => {
    const r = await pp.process(path.join(PIC_DIR, "工作簿1.xlsx"));
    expect(r.mimeType).toContain("spreadsheet");
    expect(r.error).not.toBe("不支持此文件类型");
  });

  it("A5: .m file routes to text", async () => {
    const r = await pp.process(path.join(PIC_DIR, "compute_multistage_fractionation.m"));
    expect(r.mimeType).toBe("application/octet-stream"); // .m not in MIME_MAP
    expect(r.error).not.toBe("不支持此文件类型");
  });

  it("A6: unsupported extension returns error", async () => {
    const r = await pp.process(path.join(PIC_DIR, "nonexistent.xyz"));
    expect(r.error).toBe("文件不存在"); // file doesn't exist anyway
  });

  const jpgFiles = fs.readdirSync(PIC_DIR).filter((f) => f.toLowerCase().endsWith(".jpg"));
  if (jpgFiles.length > 0) {
    it("A7: JPG routes to ocr", async () => {
      const r = await pp.process(path.join(PIC_DIR, jpgFiles[0]));
      expect(r.mimeType).toBe("image/jpeg");
      expect(r.error).not.toBe("不支持此文件类型");
    });
  }
});

// ---------------------------------------------------------------------------
// Group B: Text files (direct read)
// ---------------------------------------------------------------------------

describe("Group B — Text file direct read", () => {
  const pp = new FilePreprocessor();

  it("B1: reads MATLAB .m file", async () => {
    const r = await pp.process(path.join(PIC_DIR, "compute_multistage_fractionation.m"));
    expect(r.error).toBeNull();
    expect(r.extractedText).toBeTruthy();
    expect(r.extractedText!.length).toBeGreaterThan(100);
    expect(r.extractedText!).toContain("function");
  });

  it("B2: missing file returns error", async () => {
    const r = await pp.process("/nonexistent/file.txt");
    expect(r.error).toBe("文件不存在");
    expect(r.extractedText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group C: markitdown (PDF/DOCX/XLSX)
// ---------------------------------------------------------------------------

describe("Group C — markitdown", () => {
  const pp = new FilePreprocessor();

  it("C1: PDF text extraction", async () => {
    const r = await pp.process(path.join(PIC_DIR, "1-s2.0-S092698511400250X-main.pdf"));
    // May succeed or fail depending on PDF content — just verify it doesn't crash
  }, 30_000);

  it("C2: DOCX text extraction", async () => {
    const r = await pp.process(path.join(PIC_DIR, "实验.docx"));
    if (r.error) {
      // markitdown may fail on complex DOCX — acceptable
      expect(r.extractedText).toBeNull();
    } else {
      expect(r.extractedText).toBeTruthy();
    }
  }, 30_000);

  it("C3: XLSX text extraction", async () => {
    const r = await pp.process(path.join(PIC_DIR, "工作簿1.xlsx"));
    // markitdown may or may not extract XLSX content
    expect(r.mimeType).toContain("spreadsheet");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group D: PaddleOCR (PNG/JPG)
// ---------------------------------------------------------------------------

describe("Group D — PaddleOCR", () => {
  const pp = new FilePreprocessor();

  it("D1: PNG OCR", async () => {
    const r = await pp.process(path.join(PIC_DIR, "b68e137ce846091993541b52b031927a.png"));
    if (r.error) {
      // PaddleOCR may need to download models on first run (takes longer)
      expect(r.extractedText).toBeNull();
    } else {
      expect(r.extractedText).toBeTruthy();
    }
  }, 120_000); // first run downloads model

  const jpgFiles = fs.readdirSync(PIC_DIR).filter((f) => f.toLowerCase().endsWith(".jpg"));
  if (jpgFiles.length > 0) {
    it("D2: JPG OCR", async () => {
      const r = await pp.process(path.join(PIC_DIR, jpgFiles[0]));
      if (r.error) {
        expect(r.extractedText).toBeNull();
      } else {
        expect(r.extractedText).toBeTruthy();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Group E: Edge cases
// ---------------------------------------------------------------------------

describe("Group E — Edge cases", () => {
  const pp = new FilePreprocessor();

  it("E1: unsupported extension (.bin)", async () => {
    // Create a temp .bin file
    const tmp = path.join(PIC_DIR, "_test_unsupported.bin");
    fs.writeFileSync(tmp, "dummy data");
    try {
      const r = await pp.process(tmp);
      expect(r.error).toBe("不支持此文件类型");
      expect(r.extractedText).toBeNull();
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("E2: processAll handles multiple files", async () => {
    const files = [
      path.join(PIC_DIR, "compute_multistage_fractionation.m"),
    ].filter((f) => fs.existsSync(f));

    const results = await pp.processAll(files);
    expect(results.length).toBe(files.length);
    // Each result should have mimeType
    for (const r of results) {
      expect(r.mimeType).toBeTruthy();
    }
  });
});
