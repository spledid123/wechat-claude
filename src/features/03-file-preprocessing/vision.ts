/**
 * DeepSeek vision image handling shared by both image modes:
 *
 *  direct — images are inlined as image content blocks in the main
 *           conversation (payload preparation only).
 *  split  — images are parsed into description + transcript text first
 *           (extractImageWithVision), then injected into the conversation
 *           model's context.
 *
 * Talks directly to the Anthropic-compatible endpoint (no claude CLI
 * subprocess) so a single image costs one fast HTTP round trip.
 */

import fs from "node:fs";
import path from "node:path";

export type InlineImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Media types DeepSeek accepts (detected from content, never from extensions). */
const INLINE_MEDIA_TYPES = new Set<InlineImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Raw-file cap; base64 inflates by ~4/3, staying well under the 32MiB per-image limit. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface ImagePayload {
  name: string;
  base64: string;
  mediaType: InlineImageMediaType;
  byteSize: number;
}

export type PrepareResult =
  | { ok: true; payload: ImagePayload }
  | { ok: false; error: string };

/** Detect the real image format from magic bytes — file extensions are unreliable. */
export function sniffImageMime(buf: Buffer): InlineImageMediaType | "image/bmp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (
    buf.length >= 12
    && buf.toString("ascii", 0, 4) === "RIFF"
    && buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

/** Read an image file and gate it against the DeepSeek input limits. */
export function prepareImagePayload(filePath: string, name: string): PrepareResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `读取图片失败: ${(err as Error).message}` };
  }

  const mime = sniffImageMime(buf);
  if (!mime) {
    return { ok: false, error: "无法识别图片格式（支持 JPG/PNG/GIF/WebP）" };
  }
  if (mime === "image/bmp") {
    return { ok: false, error: "暂不支持 BMP 图片，请转换为 PNG 或 JPG 后重发" };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `图片过大（${(buf.length / (1024 * 1024)).toFixed(1)}MB，上限 15MB）`,
    };
  }

  return {
    ok: true,
    payload: { name, base64: buf.toString("base64"), mediaType: mime, byteSize: buf.length },
  };
}

export interface VisionExtraction {
  description: string;
  transcript: string;
}

/**
 * Run an async map with bounded parallelism. Used to transcribe scanned-PDF
 * pages concurrently — the vision endpoint accepts parallel requests, and a
 * 20-page batch drops from ~4min (serial) to ~1min at concurrency 20.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Transcribe rendered PDF pages concurrently into "[第N页]\n<text>" blocks.
 * Parallel bursts occasionally return empty — each failed page gets one
 * serial retry before falling back to a placeholder.
 */
export async function transcribePdfPages(
  pagePaths: string[],
  startPage: number,
  options: { model: string; concurrency: number },
): Promise<string[]> {
  const extract = (pagePath: string) =>
    extractImageFileWithVision(pagePath, path.basename(pagePath), { model: options.model });

  const texts: (string | null)[] = await mapWithConcurrency(
    pagePaths,
    options.concurrency,
    async (pagePath) => {
      const extracted = await extract(pagePath);
      return extracted.ok ? extracted.text : null;
    },
  );

  for (let i = 0; i < texts.length; i++) {
    if (texts[i] !== null) continue;
    const extracted = await extract(pagePaths[i]);
    if (extracted.ok) texts[i] = extracted.text;
  }

  return pagePaths.map((_pagePath, i) => {
    const pageNumber = startPage + i;
    return `[第${pageNumber}页]\n${texts[i] ?? "(识别失败)"}`;
  });
}

/**
 * Rough wall-time estimate for a concurrent transcription batch, built on a
 * ~12s/page serial baseline (dense book pages; plain documents are faster).
 */
export function estimateVisionMinutes(pageCount: number, concurrency: number): number {
  const effective = Math.max(1, Math.min(concurrency, pageCount));
  const seconds = Math.max(45, Math.ceil((pageCount * 12) / effective));
  return Math.max(1, Math.ceil(seconds / 60));
}

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Convenience wrapper: prepare a file and extract its content in one call. */
export async function extractImageFileWithVision(
  filePath: string,
  name: string,
  options: { model: string; timeoutMs?: number },
): Promise<ExtractResult> {
  const prepared = prepareImagePayload(filePath, name);
  if (!prepared.ok) return prepared;
  return extractImageWithVision(prepared.payload, options);
}

const EXTRACTION_PROMPT = [
  "你是图片解析助手。请解析这张图片并只输出一个 JSON 对象，不要输出其他任何文字：",
  '{"description": "图片内容的中文描述（场景、物体、人物、图表类型等；纯照片/表情包也必须描述）",',
  ' "transcript": "图中所有可见文字的逐字转录，按阅读顺序排列；图中没有文字则为空字符串"}',
].join("\n");

/**
 * Ask the vision model to describe the image and transcribe its text.
 * Returns "【图片描述】…\n【图中文字】…" on success.
 */
export async function extractImageWithVision(
  payload: ImagePayload,
  options: { model: string; timeoutMs?: number },
): Promise<ExtractResult> {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic")
    .replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const timeoutMs = options.timeoutMs ?? readTimeoutEnv();

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ANTHROPIC_API_KEY) {
    headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  }
  if (!headers["x-api-key"] && !headers.authorization) {
    return { ok: false, error: "未配置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        // The vision model reasons before emitting text and thinking counts
        // against max_tokens — a small budget truncates the JSON answer
        // mid-stream on complex images.
        max_tokens: 8192,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: payload.mediaType as string,
                  data: payload.base64,
                },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return { ok: false, error: describeHttpError(response.status, bodyText) };
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
    };
    if (data.error) {
      return { ok: false, error: data.error.message ?? "vision 接口返回错误" };
    }

    const text = (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (!text) {
      return { ok: false, error: "vision 模型未返回内容" };
    }

    const extraction = parseExtraction(text);
    const transcriptPart = extraction.transcript.trim()
      ? extraction.transcript.trim()
      : "（图中无文字）";
    return {
      ok: true,
      text: `【图片描述】${extraction.description.trim() || "（无描述）"}\n【图中文字】${transcriptPart}`,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (controller.signal.aborted) {
      return { ok: false, error: `图片解析超时（${Math.round(timeoutMs / 1000)}s）` };
    }
    return { ok: false, error: `图片解析请求失败: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseExtraction(text: string): VisionExtraction {
  // Tolerant parse: models sometimes wrap JSON in prose or code fences.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<VisionExtraction>;
      if (typeof parsed.description === "string" || typeof parsed.transcript === "string") {
        return {
          description: typeof parsed.description === "string" ? parsed.description : "",
          transcript: typeof parsed.transcript === "string" ? parsed.transcript : "",
        };
      }
    } catch {
      // Fall through — treat the whole text as the description.
    }
  }
  return { description: text, transcript: "" };
}

function describeHttpError(status: number, body: string): string {
  const hint = body.slice(0, 200);
  if (status === 400 && /not support image|does not support/i.test(body)) {
    return `当前视觉模型不支持图片输入，请检查模型配置（${hint || status}）`;
  }
  if (status === 401 || status === 403) {
    return "API 鉴权失败，请检查 ANTHROPIC_API_KEY 配置";
  }
  if (status === 429) {
    return "图片解析请求过于频繁，请稍后重试";
  }
  return `图片解析失败（HTTP ${status}）${hint ? `: ${hint}` : ""}`;
}

function readTimeoutEnv(): number {
  const raw = process.env.WECHAT_CLAUDE_VISION_TIMEOUT_MS;
  if (!raw) return 90_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}
