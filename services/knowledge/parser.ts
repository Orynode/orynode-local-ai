/**
 * 文档解析入口
 *
 * - PDF：pdfjs-dist（Workers 需 DOM 垫片；主线程加载 worker 模块，避免 Vite 假路径）
 * - TXT / Markdown：UTF-8 文本；按标题或分段映射为「页」便于引用
 */

import "./pdf-dom-polyfill";
import type { ParsedDocument, ParsedPage } from "./types";
import { type KnowledgeFileKind } from "./formats";
import { loadPdfJs } from "./pdfjs-load";
import {
  parseMarkdownHeadingLine,
  pushHeadingPath,
  type HeadingStackEntry,
} from "./indexing/markdown-headings";

export async function parseDocument(
  buffer: ArrayBuffer,
  kind: KnowledgeFileKind,
): Promise<ParsedDocument> {
  if (kind === "pdf") {
    return parsePdf(buffer);
  }
  return parsePlainText(buffer, kind);
}

/**
 * 从 PDF 文件 buffer 中提取文本
 */
export async function parsePdf(buffer: ArrayBuffer): Promise<ParsedDocument> {
  const { getDocument } = await loadPdfJs();
  // pdfjs 可能 transfer 掉 data 底层 ArrayBuffer；用副本避免调用方缓冲被掏空
  const data = new Uint8Array(buffer.slice(0));
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  const pages: ParsedPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push({ pageNumber, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    pageCount: pdf.numPages,
    pages,
  };
}

/**
 * TXT / Markdown → 文本页
 * - 优先按 Markdown 标题切开，并写入 headingPath / 行号
 * - 否则整篇作为第 1 页（后续由 chunker 再切）
 */
export function parsePlainText(
  buffer: ArrayBuffer,
  _kind: Exclude<KnowledgeFileKind, "pdf"> = "txt",
): ParsedDocument {
  const text = new TextDecoder("utf-8")
    .decode(buffer)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  const trimmed = text.trim();
  if (!trimmed) {
    return { pageCount: 0, pages: [] };
  }

  const fullLines = trimmed.split("\n");
  const headingSplit = trimmed
    .split(/\n(?=#{1,3}\s+)/)
    .map((part) => part.trim())
    .filter(Boolean);

  let pages: ParsedPage[];
  if (headingSplit.length > 1) {
    let stack: HeadingStackEntry[] = [];
    let searchFrom = 0;
    pages = headingSplit.map((part, index) => {
      const firstLine = part.split("\n")[0] ?? "";
      const heading = parseMarkdownHeadingLine(firstLine);
      let headingPath: string[] | undefined;
      if (heading) {
        const pushed = pushHeadingPath(stack, heading);
        stack = pushed.stack;
        headingPath = pushed.path;
      }

      const startLine = findSectionStartLine(fullLines, part, searchFrom);
      const lineCount = part.split("\n").length;
      const endLine = startLine + lineCount - 1;
      searchFrom = startLine + lineCount - 1;

      return {
        pageNumber: index + 1,
        text: part,
        headingPath,
        startLine,
        endLine,
      };
    });
  } else {
    const pagesSource = splitOversizedPage(trimmed);
    let lineCursor = 1;
    pages = pagesSource.map((part, index) => {
      const lineCount = part.split("\n").length;
      const startLine = lineCursor;
      const endLine = lineCursor + lineCount - 1;
      lineCursor = endLine + 1;
      return {
        pageNumber: index + 1,
        text: part,
        startLine,
        endLine,
      };
    });
  }

  return {
    pageCount: pages.length,
    pages,
  };
}

/** 在全文行中定位 section 起始行（1-based） */
function findSectionStartLine(
  fullLines: string[],
  section: string,
  fromIndex: number,
): number {
  const first = section.split("\n")[0] ?? "";
  for (let i = Math.max(0, fromIndex); i < fullLines.length; i += 1) {
    if (fullLines[i] === first || fullLines[i]?.trim() === first.trim()) {
      return i + 1;
    }
  }
  return Math.max(1, fromIndex + 1);
}

/** 无标题的长文按空行块聚合，避免单页过大（仍交 chunker 细切） */
function splitOversizedPage(text: string, maxChars = 12000): string[] {
  if (text.length <= maxChars) return [text];
  const blocks = text.split(/\n{2,}/);
  const pages: string[] = [];
  let current = "";
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (current && next.length > maxChars) {
      pages.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) pages.push(current);
  return pages.length > 0 ? pages : [text];
}
