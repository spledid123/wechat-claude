import fs from "node:fs";
import path from "node:path";

export interface PendingWechatFile {
  filePath: string;
  fileName: string;
  signature: string;
  kind: "image" | "file";
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
