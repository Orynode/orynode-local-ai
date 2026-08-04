"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { friendlyPdfError } from "../../lib/preview-errors";
import {
  isHighlightPageActive,
  rectsForHighlightPlan,
  resolvePdfHighlightPlan,
  type PdfTextItemLike,
  type NormalizedBboxTuple,
} from "../../lib/preview-pdf-highlight";
import { loadPdfJs } from "../../../services/knowledge/pdfjs-load";

type PdfPreviewCanvasProps = {
  /** 缓存键：切换文档时强制重建；翻页不变更 */
  cacheKey: string;
  /** 直链加载（大文件）；与 data 二选一 */
  url?: string | null;
  /** 已缓冲的 PDF 字节（小文件，避免二次下载） */
  data?: ArrayBuffer | null;
  page: number;
  /** 引用目标页（1-based）；仅当前页等于此页时绘制高亮 */
  highlightPage?: number | null;
  /** OCR 归一化 bbox；优先于字符偏移 */
  highlightBbox?: NormalizedBboxTuple | null;
  /** 页内字符高亮（与 parsePdf join(" ") 偏移一致） */
  highlightStart?: number | null;
  highlightEnd?: number | null;
  onNumPages: (n: number) => void;
  onError: (message: string) => void;
};

type DocSession = {
  /** 与 epochRef 对齐；过期 session 不得再渲染/写 state */
  epoch: number;
  numPages: number;
};

function destroyLoadingTask(task: PDFDocumentLoadingTask | null) {
  if (task && typeof task.destroy === "function") {
    void task.destroy().catch(() => undefined);
  }
}

function cleanupDocument(doc: PDFDocumentProxy | null) {
  // pdf.js v6：文档用 cleanup()；destroy() 只在 LoadingTask 上
  if (doc && typeof doc.cleanup === "function") {
    void Promise.resolve(doc.cleanup()).catch(() => undefined);
  }
}

function cancelRenderTask(task: RenderTask | null) {
  if (task && typeof task.cancel === "function") {
    try {
      task.cancel();
    } catch {
      /* ignore */
    }
  }
}

/**
 * pdf.js 单页渲染：文档按 cacheKey 缓存，翻页只 getPage。
 * 用 epoch + docRef 保证销毁后不会再对旧实例 setState / getPage。
 */
export function PdfPreviewCanvas({
  cacheKey,
  url,
  data,
  page,
  highlightPage,
  highlightBbox,
  highlightStart,
  highlightEnd,
  onNumPages,
  onError,
}: PdfPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const epochRef = useRef(0);
  const [session, setSession] = useState<DocSession | null>(null);
  const [busy, setBusy] = useState(true);
  const [hasPainted, setHasPainted] = useState(false);

  useEffect(() => {
    const epoch = ++epochRef.current;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let ownedDoc: PDFDocumentProxy | null = null;

    docRef.current = null;

    async function loadDocument() {
      if (!url && !data) {
        if (epochRef.current === epoch) {
          onError("缺少 PDF 数据");
          setBusy(false);
        }
        return;
      }
      try {
        const pdfjs = await loadPdfJs();
        // pdfjs 可能 transfer 掉 data 底层 ArrayBuffer；用副本避免调用方缓冲被掏空
        loadingTask = data
          ? pdfjs.getDocument({
              data: new Uint8Array(data.slice(0)),
              useSystemFonts: true,
              useWorkerFetch: false,
            })
          : pdfjs.getDocument({
              url: url!,
              withCredentials: true,
              useSystemFonts: true,
              useWorkerFetch: false,
            });
        const next = await loadingTask.promise;

        if (epochRef.current !== epoch) {
          cleanupDocument(next);
          destroyLoadingTask(loadingTask);
          loadingTask = null;
          return;
        }

        ownedDoc = next;
        docRef.current = next;
        setSession({ epoch, numPages: next.numPages });
        onNumPages(next.numPages);
      } catch (error) {
        if (epochRef.current === epoch) {
          const message = friendlyPdfError(error) || "PDF 加载失败";
          onError(message);
          setBusy(false);
        }
      }
    }

    void loadDocument();

    return () => {
      if (epochRef.current === epoch) {
        epochRef.current += 1;
      }
      if (docRef.current === ownedDoc) {
        docRef.current = null;
      }
      setSession((current) => (current?.epoch === epoch ? null : current));
      cleanupDocument(ownedDoc);
      destroyLoadingTask(loadingTask);
      ownedDoc = null;
      loadingTask = null;
    };
  }, [cacheKey, url, data, onNumPages, onError]);

  useEffect(() => {
    if (!session) return;
    const { epoch, numPages } = session;
    const doc = docRef.current;
    if (!doc || epochRef.current !== epoch || docRef.current !== doc) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    async function renderPage() {
      setBusy(true);
      try {
        if (
          cancelled ||
          epochRef.current !== epoch ||
          docRef.current !== doc
        ) {
          return;
        }
        const safePage = Math.min(Math.max(1, page), numPages);
        const pdfPage = await doc.getPage(safePage);
        if (
          cancelled ||
          epochRef.current !== epoch ||
          docRef.current !== doc
        ) {
          return;
        }

        const canvas = canvasRef.current;
        const highlight = highlightRef.current;
        const wrap = wrapRef.current;
        if (!canvas) return;
        const base = pdfPage.getViewport({ scale: 1 });
        // 用外层滚动容器宽高适配，单页尽量落在可视区内，避免出现滚动条
        const hostEl = wrap?.closest(".doc-preview-pdf");
        const host =
          hostEl instanceof HTMLElement
            ? hostEl
            : wrap?.parentElement instanceof HTMLElement
              ? wrap.parentElement
              : null;
        const pad = 24; // .doc-preview-pdf padding 12 * 2
        const maxWidth = Math.max(280, (host?.clientWidth || 720) - pad);
        const maxHeight = Math.max(280, (host?.clientHeight || 900) - pad);
        const scale = Math.min(
          1.5,
          maxWidth / base.width,
          maxHeight / base.height,
        );
        const viewport = pdfPage.getViewport({ scale });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建画布");

        const width = Math.floor(viewport.width);
        const height = Math.floor(viewport.height);
        canvas.width = width;
        canvas.height = height;
        // 同步 CSS 尺寸，避免 max-width:100% 与位图不一致
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        context.clearRect(0, 0, width, height);

        renderTask = pdfPage.render({
          canvasContext: context,
          canvas,
          viewport,
        });
        await renderTask.promise;

        if (
          cancelled ||
          epochRef.current !== epoch ||
          docRef.current !== doc
        ) {
          return;
        }

        if (highlight) {
          highlight.width = width;
          highlight.height = height;
          highlight.style.width = `${width}px`;
          highlight.style.height = `${height}px`;
          const hctx = highlight.getContext("2d");
          if (hctx) {
            hctx.clearRect(0, 0, width, height);
            if (isHighlightPageActive(safePage, highlightPage)) {
              const plan = resolvePdfHighlightPlan({
                bbox: highlightBbox,
                startOffset: highlightStart,
                endOffset: highlightEnd,
              });
              let items: PdfTextItemLike[] | undefined;
              if (plan.mode === "offsets") {
                const textContent = await pdfPage.getTextContent();
                items = [];
                for (const item of textContent.items) {
                  if (
                    item &&
                    typeof item === "object" &&
                    "str" in item &&
                    "transform" in item &&
                    Array.isArray((item as PdfTextItemLike).transform)
                  ) {
                    items.push(item as PdfTextItemLike);
                  }
                }
              }
              if (
                cancelled ||
                epochRef.current !== epoch ||
                docRef.current !== doc
              ) {
                return;
              }
              const rects = rectsForHighlightPlan(plan, {
                pageWidthPx: width,
                pageHeightPx: height,
                items,
                convertToViewportRectangle: (pdfRect) =>
                  viewport.convertToViewportRectangle(pdfRect),
              });
              hctx.fillStyle = "rgb(36 74 54 / 28%)";
              for (const rect of rects) {
                hctx.fillRect(rect.left, rect.top, rect.width, rect.height);
              }
              if (rects.length > 0 && wrap) {
                const scroller = wrap.closest(".doc-preview-pdf");
                if (scroller instanceof HTMLElement) {
                  scroller.scrollTop = Math.max(0, rects[0].top - 48);
                }
              }
            }
          }
        }

        if (
          cancelled ||
          epochRef.current !== epoch ||
          docRef.current !== doc
        ) {
          return;
        }
        setHasPainted(true);
      } catch (error) {
        if (
          cancelled ||
          epochRef.current !== epoch ||
          docRef.current !== doc
        ) {
          return;
        }
        const message = friendlyPdfError(error);
        if (!message) return;
        onError(message);
      } finally {
        if (
          !cancelled &&
          epochRef.current === epoch &&
          docRef.current === doc
        ) {
          setBusy(false);
        }
      }
    }

    void renderPage();
    return () => {
      cancelled = true;
      cancelRenderTask(renderTask);
      renderTask = null;
    };
  }, [
    session,
    page,
    highlightPage,
    highlightBbox,
    highlightStart,
    highlightEnd,
    onError,
  ]);

  const showStatus = busy && !hasPainted;

  return (
    <div className="doc-preview-pdf">
      {showStatus ? (
        <p className="doc-preview-status">正在渲染页面…</p>
      ) : null}
      <div ref={wrapRef} className="doc-preview-pdf-stage">
        <canvas ref={canvasRef} className="doc-preview-canvas" />
        <canvas
          ref={highlightRef}
          className="doc-preview-highlight"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
