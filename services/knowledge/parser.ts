/**
 * 文档解析入口
 *
 * - PDF：pdfjs-dist（Workers 需 DOM 垫片）
 * - TXT / Markdown：UTF-8 文本；按标题或分段映射为「页」便于引用
 */

import "./pdf-dom-polyfill";
import type { ParsedDocument, ParsedPage } from "./types";
import { type KnowledgeFileKind, isPdfMagic } from "./formats";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

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
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
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
 * - 优先按 Markdown 标题切开
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

  const headingSplit = trimmed.split(/\n(?=#{1,3}\s+)/).map((part) => part.trim()).filter(Boolean);
  const pagesSource =
    headingSplit.length > 1 ? headingSplit : splitOversizedPage(trimmed);

  const pages: ParsedPage[] = pagesSource.map((part, index) => ({
    pageNumber: index + 1,
    text: part,
  }));

  return {
    pageCount: pages.length,
    pages,
  };
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
