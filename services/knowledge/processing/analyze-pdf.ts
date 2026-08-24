/**
 * PDF 页面分析：native 文本 + 大图探测（KE-027）
 *
 * 仅文本/算子探测；页渲染见 pdf-render（Node + @napi-rs/canvas）。
 */

import "../pdf-dom-polyfill";
import type { ParsedDocument, ParsedPage } from "../types";
import { loadPdfJs } from "../pdfjs-load";
import { assessPageTextQuality, type PageTextQuality } from "./page-quality";

const OPS_PAINT_IMAGE_XOBJECT = 85; // pdfjs OPS.paintImageXObject

export type AnalyzedPdfPage = {
  pageNumber: number;
  text: string;
  quality: PageTextQuality;
};

export type AnalyzedPdf = {
  pageCount: number;
  pages: AnalyzedPdfPage[];
  parsed: ParsedDocument;
};

/**
 * 粗略判断页面是否含较大位图（扫描页常见）。
 * 无可靠尺寸时，只要有 paintImageXObject 且文本很少，由 quality 规则处理。
 */
async function pageHasLargeRaster(
  page: {
    getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  },
): Promise<boolean> {
  try {
    const ops = await page.getOperatorList();
    let imageOps = 0;
    for (let i = 0; i < ops.fnArray.length; i += 1) {
      if (ops.fnArray[i] === OPS_PAINT_IMAGE_XOBJECT) {
        imageOps += 1;
      }
    }
    // 显著栅格：至少一张图。有可用 native 文本时 page-quality 仍判 native。
    return imageOps >= 1;
  } catch {
    return false;
  }
}

/**
 * native 文本提取的资源上限（与 parsePdf 对齐）：
 * 分析阶段同样逐页执行 getOperatorList，无上限可被恶意 PDF 拖垮主进程。
 */
const MAX_ANALYZE_PDF_PAGES = 500;
const MAX_ANALYZE_PAGE_TEXT_CHARS = 100_000;

export async function analyzePdfPages(buffer: ArrayBuffer): Promise<AnalyzedPdf> {
  const { getDocument } = await loadPdfJs();
  const data = new Uint8Array(buffer.slice(0));
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    useWorkerFetch: false,
    // pdfjs v6 已移除 PostScript eval 路径（旧版需 isEvalSupported:false）
  });
  const pdf = await loadingTask.promise;
  const pages: AnalyzedPdfPage[] = [];
  const parsedPages: ParsedPage[] = [];
  let truncated = false;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (pageNumber > MAX_ANALYZE_PDF_PAGES) {
        truncated = true;
        break;
      }
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      if (text.length > MAX_ANALYZE_PAGE_TEXT_CHARS) {
        text = text.slice(0, MAX_ANALYZE_PAGE_TEXT_CHARS);
      }
      const hasLargeRasterImage = await pageHasLargeRaster(page);
      const quality = assessPageTextQuality({
        pageNumber,
        text,
        hasLargeRasterImage,
      });
      pages.push({ pageNumber, text, quality });
      parsedPages.push({ pageNumber, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const effectivePageCount = truncated ? pages.length : pdf.numPages;
  return {
    pageCount: effectivePageCount,
    pages,
    parsed: { pageCount: effectivePageCount, pages: parsedPages },
  };
}
