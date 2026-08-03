/**
 * PDF 页面分析：native 文本 + 大图探测（KE-027）
 *
 * 仅文本/算子探测；页渲染见 pdf-render（Node + @napi-rs/canvas）。
 */

import "../pdf-dom-polyfill";
import type { ParsedDocument, ParsedPage } from "../types";
import { assessPageTextQuality, type PageTextQuality } from "./page-quality";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const worker = (await import(
        /* @vite-ignore */
        "pdfjs-dist/legacy/build/pdf.worker.mjs"
      )) as { WorkerMessageHandler: unknown };
      const g = globalThis as typeof globalThis & {
        pdfjsWorker?: { WorkerMessageHandler: unknown };
      };
      g.pdfjsWorker = worker;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

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

export async function analyzePdfPages(buffer: ArrayBuffer): Promise<AnalyzedPdf> {
  const { getDocument } = await loadPdfJs();
  const data = new Uint8Array(buffer.slice(0));
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  const pages: AnalyzedPdfPage[] = [];
  const parsedPages: ParsedPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
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

  return {
    pageCount: pdf.numPages,
    pages,
    parsed: { pageCount: pdf.numPages, pages: parsedPages },
  };
}
