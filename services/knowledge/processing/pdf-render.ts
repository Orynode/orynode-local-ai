/**
 * Node 侧 PDF 单页渲染（KE-027）
 *
 * 仅 data-service / Node 主进程加载 @napi-rs/canvas；vinext Worker 仍用 stub。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCR_CONFIG } from "../../../config/defaults";
import { loadPdfJs } from "../pdfjs-load";

export type RenderedPageImage = {
  pageNumber: number;
  pngPath: string;
  width: number;
  height: number;
  mimeType: "image/png";
  bytes: Uint8Array;
};

function scaleForLimits(
  widthPt: number,
  heightPt: number,
  dpi: number,
): { width: number; height: number; scale: number } {
  const scale0 = dpi / 72;
  let width = Math.max(1, Math.floor(widthPt * scale0));
  let height = Math.max(1, Math.floor(heightPt * scale0));
  const longEdge = Math.max(width, height);
  if (longEdge > OCR_CONFIG.maxRenderedLongEdge) {
    const s = OCR_CONFIG.maxRenderedLongEdge / longEdge;
    width = Math.max(1, Math.floor(width * s));
    height = Math.max(1, Math.floor(height * s));
  }
  const pixels = width * height;
  if (pixels > OCR_CONFIG.maxRenderedPixels) {
    const s = Math.sqrt(OCR_CONFIG.maxRenderedPixels / pixels);
    width = Math.max(1, Math.floor(width * s));
    height = Math.max(1, Math.floor(height * s));
  }
  const scale = width / widthPt;
  return { width, height, scale };
}

/**
 * 渲染单页为 PNG。tempDir 由调用方提供或自动创建；调用方负责清理。
 */
export async function renderPdfPageToPng(
  pdfBytes: Uint8Array | ArrayBuffer,
  pageNumber: number,
  options?: {
    tempDir?: string;
    dpi?: number;
    signal?: AbortSignal;
  },
): Promise<RenderedPageImage & { tempDir: string; ownedTempDir: boolean }> {
  if (options?.signal?.aborted) {
    throw new Error("OCR_CANCELLED");
  }

  let createCanvas: typeof import("@napi-rs/canvas").createCanvas;
  try {
    const canvasMod = await import("@napi-rs/canvas");
    createCanvas = canvasMod.createCanvas;
    // pdfjs page.render 走全局 Path2D；pdf-dom-polyfill 的 stub 只有 addPath，
    // 复杂页会报 path.moveTo is not a function。Node 渲染必须换成 napi 实现。
    type GlobalWithPdfShims = typeof globalThis & {
      Path2D?: new (...args: unknown[]) => unknown;
      DOMMatrix?: new (...args: unknown[]) => unknown;
    };
    const g = globalThis as GlobalWithPdfShims;
    if (canvasMod.Path2D) {
      g.Path2D = canvasMod.Path2D as unknown as GlobalWithPdfShims["Path2D"];
    }
    if (canvasMod.DOMMatrix) {
      g.DOMMatrix =
        canvasMod.DOMMatrix as unknown as GlobalWithPdfShims["DOMMatrix"];
    }
  } catch {
    throw new Error("OCR_RENDER_UNAVAILABLE");
  }

  const ownedTempDir = !options?.tempDir;
  const tempDir =
    options?.tempDir ??
    (await mkdtemp(join(tmpdir(), "orynode-ocr-")));
  await mkdir(tempDir, { recursive: true });

  const { getDocument } = await loadPdfJs();
  const data =
    pdfBytes instanceof ArrayBuffer
      ? new Uint8Array(pdfBytes.slice(0))
      : new Uint8Array(pdfBytes);

  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    useWorkerFetch: false,
    disableFontFace: true,
  });

  try {
    const pdf = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const dpi = options?.dpi ?? OCR_CONFIG.renderDpi;
    const { width, height, scale } = scaleForLimits(
      base.width,
      base.height,
      dpi,
    );
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    await page.render({
      canvasContext: ctx as never,
      viewport,
      // @ts-expect-error pdfjs types
      canvas,
    }).promise;

    if (options?.signal?.aborted) {
      throw new Error("OCR_CANCELLED");
    }

    const buffer = canvas.toBuffer("image/png");
    const pngPath = join(tempDir, `page-${pageNumber}.png`);
    await writeFile(pngPath, buffer);
    page.cleanup();

    return {
      pageNumber,
      pngPath,
      width,
      height,
      mimeType: "image/png",
      bytes: new Uint8Array(buffer),
      tempDir,
      ownedTempDir,
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function cleanupRenderTemp(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}
