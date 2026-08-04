/**
 * 统一加载 pdfjs-dist legacy（客户端预览 / Node 解析共用）
 *
 * vinext / Vite 下动态 import("./pdf.worker.mjs") 会指到不存在的
 * `.vite/deps.../pdf.worker.mjs`。显式导入 worker 并挂到 globalThis，
 * 让 pdfjs 走主线程 fake worker。
 *
 * Node 侧调用前需先 import `./pdf-dom-polyfill`（本模块不引入垫片，避免污染浏览器）。
 */

export type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type PdfJsWorkerModule = {
  WorkerMessageHandler: unknown;
};

let pdfjsPromise: Promise<PdfJsModule> | null = null;

export async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const worker = (await import(
        /* @vite-ignore */
        "pdfjs-dist/legacy/build/pdf.worker.mjs"
      )) as PdfJsWorkerModule;
      const g = globalThis as typeof globalThis & {
        pdfjsWorker?: PdfJsWorkerModule;
      };
      g.pdfjsWorker = worker;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}
