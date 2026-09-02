import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

export interface PendingWechatFile {
  filePath: string;
  fileName: string;
  signature: string;
  kind: "image" | "file";
}

export interface OfficePackageValidation {
  ok: boolean;
  problems: string[];
}

/** Zip-based Office formats we validate before sending to WeChat. */
const OFFICE_PACKAGE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".docm", ".xlsm", ".pptm"]);

/** Legal top-level locations inside an OPC/Office package. */
const ALLOWED_TOP_LEVEL = new Set([
  "[content_types].xml",
  "_rels",
  "docprops",
  "word",
  "xl",
  "ppt",
  "customxml",
]);

/**
 * Sanity-check generated Office files before they go out. Catches the
 * "agent stuffed a stray file into the OOXML zip" failure mode that lenient
 * readers tolerate but Word rejects with 无法读取的内容.
 */
export function validateOfficePackage(filePath: string): OfficePackageValidation {
  const ext = path.extname(filePath).toLowerCase();
  if (!OFFICE_PACKAGE_EXTENSIONS.has(ext)) {
    return { ok: true, problems: [] };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch {
    return { ok: false, problems: ["不是有效的 zip/Office 包结构"] };
  }

  const problems: string[] = [];
  const entries = zip.getEntries();

  const ct = entries.find((e) => e.entryName.toLowerCase() === "[content_types].xml");
  if (!ct) {
    problems.push("缺少 [Content_Types].xml");
  } else {
    const text = ct.getData().toString("utf-8");
    if (!text.includes("<Types") || (!text.includes("<Default ") && !text.includes("<Override "))) {
      problems.push("[Content_Types].xml 内容异常");
    }
  }

  const strays = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, "/"))
    .filter((name) => {
      const top = name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
      return !ALLOWED_TOP_LEVEL.has(top.toLowerCase());
    });
  if (strays.length > 0) {
    problems.push(`包含非法嵌入部件: ${strays.slice(0, 3).join(", ")}${strays.length > 3 ? " 等" : ""}`);
  }

  return { ok: problems.length === 0, problems };
}

interface SentState {
  sent: Record<string, string>;
}

const SENT_STATE_FILE = ".sent.json";
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);

export function collectPendingWechatFiles(sessionCwd: string): PendingWechatFile[] {
  const outputDir = path.join(sessionCwd, "working", "output_weixin");
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const sentStatePath = path.join(outputDir, SENT_STATE_FILE);
  const sentState = readSentState(sentStatePath);
  const files = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== SENT_STATE_FILE)
    .map((entry) => {
      const filePath = path.join(outputDir, entry.name);
      const stats = fs.statSync(filePath);
      const signature = `${stats.size}:${stats.mtimeMs}`;
      return {
        filePath,
        fileName: entry.name,
        signature,
        kind: detectKind(entry.name),
      } satisfies PendingWechatFile;
    })
    .filter((entry) => sentState.sent[entry.fileName] !== entry.signature)
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "en"));

  return files;
}

export function markWechatFilesSent(sessionCwd: string, files: PendingWechatFile[]): void {
  if (files.length === 0) {
    return;
  }

  const outputDir = path.join(sessionCwd, "working", "output_weixin");
  const sentStatePath = path.join(outputDir, SENT_STATE_FILE);
  const sentState = readSentState(sentStatePath);

  for (const file of files) {
    sentState.sent[file.fileName] = file.signature;
  }

  fs.writeFileSync(sentStatePath, JSON.stringify(sentState, null, 2), "utf-8");
}

function detectKind(fileName: string): "image" | "file" {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()) ? "image" : "file";
}

function readSentState(filePath: string): SentState {
  if (!fs.existsSync(filePath)) {
    return { sent: {} };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SentState>;
    return {
      sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {},
    };
  } catch {
    return { sent: {} };
  }
}
