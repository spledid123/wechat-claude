/**
 * In-process MCP tools exposing the bridge's preprocessing primitives to the
 * agent (SDK createSdkMcpServer — no subprocess, no network).
 *
 * Eager preprocessing in the bridge stays the primary path (deterministic,
 * zero agent turns). These tools are the on-demand complement: chunked reads
 * of large documents, scanned-PDF continuation beyond the eager page cap, and
 * transcription of images the agent itself produced.
 *
 * Each message creates a fresh instance via the Bridge's createMcpServers
 * hook, so tools close over that session's workspace — rendered PNGs always
 * land inside working/pdf_pages/, never outside the workspace.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import path from "node:path";
import type { FilePreprocessor } from "../../03-file-preprocessing/preprocessor.js";
import {
  extractImageFileWithVision,
  transcribePdfPages,
  estimateVisionMinutes,
} from "../../03-file-preprocessing/vision.js";
import type { RuntimeConfig } from "../../../runtime/config.js";

/** Matches the eager scanned-PDF fallback cap — one tool call, one batch. */
const MAX_PAGES_PER_CALL = 20;

/** Batches below this size are fast enough to skip the WeChat ETA message. */
const NOTIFY_MIN_PAGES = 5;

export interface BridgeToolsParams {
  sessionCwd: string;
  preprocessor: FilePreprocessor;
  getConfig: () => RuntimeConfig;
  /** Sends a WeChat message to this session's user (progress notices). */
  notify?: (text: string) => Promise<void>;
}

/** Build the in-process "bridge" MCP server for one session/message. */
export function createBridgeMcpServer(params: BridgeToolsParams): Record<string, unknown> {
  const { sessionCwd, preprocessor, getConfig, notify } = params;
  const resolveInput = (value: string) => path.resolve(sessionCwd, value);
  const pagesDir = path.join(sessionCwd, "working", "pdf_pages");

  const extractDocument = tool(
    "extract_document",
    "把 PDF/Word/Excel/PPT/epub/msg/zip 等文档或文本文件转成文本（markitdown）。"
    + "用于读取用户发来的文档或工作区里的文件；超长文本会截断并说明。",
    { file_path: z.string().describe("文件路径（相对工作区或绝对路径）") },
    async ({ file_path }) => {
      const result = await preprocessor.process(resolveInput(file_path));
      if (result.error || result.extractedText === null) {
        return textResult(`提取失败: ${result.error ?? "未提取到文本"}`, true);
      }
      const note = result.truncated
        ? `\n\n[已按上限截断；完整文件在 ${file_path}，可用 Read 工具或调整范围分块读取]`
        : "";
      return textResult(result.extractedText + note);
    },
  );

  const renderPdfPages = tool(
    "render_pdf_pages",
    "把 PDF 的指定页渲染成 PNG 图片（150DPI），保存到 working/pdf_pages/ 并返回路径列表。"
    + "适合需要查看某几页原始版面的场景（直连模式可用 Read 直接查看图片）。",
    {
      file_path: z.string().describe("PDF 路径"),
      start: z.number().int().min(1).default(1).describe("起始页码（1 起）"),
      count: z.number().int().min(1).max(MAX_PAGES_PER_CALL).default(10).describe(`渲染页数（1-${MAX_PAGES_PER_CALL}）`),
    },
    async ({ file_path, start, count }) => {
      const result = await preprocessor.renderPdfPages(resolveInput(file_path), pagesDir, {
        start,
        maxPages: count,
      });
      if (!result.ok) {
        return textResult(`渲染失败: ${result.error ?? "未知错误"}`, true);
      }
      const lines = result.pagePaths.map((p) => path.relative(sessionCwd, p).split(path.sep).join("/"));
      return textResult(
        `共 ${result.total} 页，已渲染第 ${result.start}-${result.start + result.rendered - 1} 页：\n${lines.join("\n")}`,
      );
    },
  );

  const readScannedPdf = tool(
    "read_scanned_pdf",
    "读取扫描版/图片型 PDF：渲染指定页并用视觉模型逐页转录成文字，直接返回转录文本"
    + "（无需再看图片，任何对话模式下可用）。大文档分段调用本工具。",
    {
      file_path: z.string().describe("PDF 路径"),
      start: z.number().int().min(1).default(1).describe("起始页码（1 起）"),
      count: z.number().int().min(1).max(MAX_PAGES_PER_CALL).default(10).describe(`读取页数（1-${MAX_PAGES_PER_CALL}）`),
    },
    async ({ file_path, start, count }) => {
      const render = await preprocessor.renderPdfPages(resolveInput(file_path), pagesDir, {
        start,
        maxPages: count,
      });
      if (!render.ok) {
        return textResult(`渲染失败: ${render.error ?? "未知错误"}`, true);
      }

      const config = getConfig();
      const concurrency = Math.min(config.visionConcurrency, render.pagePaths.length);
      if (notify && render.pagePaths.length >= NOTIFY_MIN_PAGES) {
        const etaMinutes = estimateVisionMinutes(render.pagePaths.length, concurrency);
        try {
          await notify(
            `📖 正在识别第 ${render.start}-${render.start + render.rendered - 1} 页`
            + `（共 ${render.total} 页，${concurrency} 路并发），预计约 ${etaMinutes} 分钟…`,
          );
        } catch {
          // Courtesy notice only — never fail the tool call over it.
        }
      }

      const parts = await transcribePdfPages(render.pagePaths, render.start, {
        model: config.visionModel,
        concurrency,
      });
      return textResult(
        `（共 ${render.total} 页，本次转录第 ${render.start}-${render.start + render.rendered - 1} 页）\n\n`
          + parts.join("\n\n"),
      );
    },
  );

  const transcribeImage = tool(
    "transcribe_image",
    "用视觉模型解析一张图片，返回中文描述和图中所有文字的逐字转录。"
    + "适合读取截图/图表，或查看工作区里生成的图片内容（JPG/PNG/GIF/WebP，单张 ≤15MB）。",
    { file_path: z.string().describe("图片路径") },
    async ({ file_path }) => {
      const model = getConfig().visionModel;
      const result = await extractImageFileWithVision(
        resolveInput(file_path),
        path.basename(file_path),
        { model },
      );
      if (!result.ok) {
        return textResult(`识别失败: ${result.error}`, true);
      }
      return textResult(result.text);
    },
  );

  const extractPdfImages = tool(
    "extract_pdf_images",
    "抽取 PDF 页面内嵌的原始图片（图表/插图，保留原始格式与分辨率），保存到 working/pdf_images/ 并返回路径。"
    + "适合需要精确查看 PDF 里的图表：直连模式用 Read 直接查看，或用 transcribe_image 转成文字描述。"
    + "小于 100×100 的图标、重复图片自动跳过，每次最多 40 张。",
    {
      file_path: z.string().describe("PDF 路径"),
      start: z.number().int().min(1).default(1).describe("起始页码（1 起）"),
      count: z.number().int().min(1).max(MAX_PAGES_PER_CALL).default(10).describe("抽取的页数范围"),
    },
    async ({ file_path, start, count }) => {
      const outDir = path.join(sessionCwd, "working", "pdf_images");
      const result = await preprocessor.extractPdfImages(resolveInput(file_path), outDir, {
        start,
        maxPages: count,
      });
      if (!result.ok) {
        return textResult(`抽取失败: ${result.error ?? "未知错误"}`, true);
      }
      if (result.imagePaths.length === 0) {
        return textResult(
          `第 ${result.start} 页起共扫描 ${count} 页，未找到内嵌图片`
          + `（跳过 ${result.skipped} 个小图标/重复项）。该 PDF 可能是纯文字或整页扫描版`
          + "（扫描版请用 read_scanned_pdf 或 render_pdf_pages）。",
        );
      }
      const lines = result.imagePaths.map((p) => path.relative(sessionCwd, p).split(path.sep).join("/"));
      return textResult(
        `已从第 ${result.start} 页起抽取 ${lines.length} 张内嵌图片（跳过 ${result.skipped} 个小图标/重复项，共 ${result.total} 页）：\n`
          + lines.join("\n")
          + "\n可搭配 Read（直连模式）查看原图，或用 transcribe_image 转成文字描述。",
      );
    },
  );

  return {
    bridge: createSdkMcpServer({
      name: "bridge",
      version: "1.0.0",
      alwaysLoad: true,
      tools: [extractDocument, renderPdfPages, readScannedPdf, transcribeImage, extractPdfImages],
    }),
  };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}
