import { FilePreprocessor } from "../src/features/03-file-preprocessing/preprocessor.js";
import fs from "node:fs";
import path from "node:path";

const picDir = path.join(process.cwd(), "test", "pic");
const supportedExtensions = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
  ".txt", ".m", ".py", ".js", ".ts", ".json", ".csv",
  ".xml", ".html", ".css", ".md", ".yml", ".yaml",
  ".sh", ".bat", ".ps1", ".c", ".cpp", ".h", ".java",
  ".rs", ".go", ".rb", ".php", ".sql", ".log",
]);

const files = fs.existsSync(picDir)
  ? fs.readdirSync(picDir)
    .filter((name) => !name.startsWith("_"))
    .filter((name) => supportedExtensions.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(picDir, name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN"))
  : [];

if (files.length === 0) {
  console.error(`No test files found in ${picDir}`);
  process.exitCode = 1;
} else {
  const pp = new FilePreprocessor();
  for (const file of files) {
    const started = Date.now();
    const result = await pp.process(file);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const chars = result.extractedText?.length ?? 0;
    const status = result.error ? `FAIL ${result.error}` : `OK ${chars} chars`;
    console.log(`${path.basename(file)}\t${result.mimeType}\t${elapsed}s\t${status}`);
  }
}
