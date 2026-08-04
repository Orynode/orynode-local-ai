"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREVIEW_PDF_BUFFER_MAX_BYTES,
  PREVIEW_SIZE_WARN_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
} from "../../../config/defaults";
import {
  buildPreviewFileUrl,
  useDocumentPreview,
  type DocumentPreviewIntent,
} from "../../lib/document-preview";
import { friendlyPreviewLoadError } from "../../lib/preview-errors";
import {
  decodePreviewFileName,
  formatPreviewBytes,
  lineStartOffset,
  previewKindFromMeta,
  readResponsePrefix,
  resolveOriginalFromResponse,
  type PreviewKind,
} from "../../lib/preview-mime";
import { Icon } from "../ui/Icon";
import { PdfPreviewCanvas } from "./PdfPreviewCanvas";

function initialPage(intent: DocumentPreviewIntent): number {
  const page = intent.page;
  if (typeof page === "number" && Number.isFinite(page) && page >= 1) {
    return Math.floor(page);
  }
  return 1;
}

/** 在单个 text 节点中按行号滚动（比 line-height 估算更准） */
function scrollPreToLine(pre: HTMLPreElement, startLine: number) {
  const textNode = pre.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    const style = getComputedStyle(pre);
    const lineHeight = parseFloat(style.lineHeight) || 18;
    pre.scrollTop = Math.max(0, (startLine - 1) * lineHeight - 48);
    return;
  }
  scrollPreToCharOffset(pre, lineStartOffset(textNode.nodeValue || "", startLine));
}

/** 按字符偏移滚动到文本位置 */
function scrollPreToCharOffset(pre: HTMLPreElement, offset: number) {
  const textNode = pre.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const text = textNode.nodeValue || "";
  const safe = Math.min(Math.max(0, offset), text.length);
  const range = document.createRange();
  range.setStart(textNode, safe);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const preRect = pre.getBoundingClientRect();
  pre.scrollTop += rect.top - preRect.top - 48;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function DocumentPreviewShell() {
  const { intent, closePreview } = useDocumentPreview();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<PreviewKind>("unknown");
  const [fileName, setFileName] = useState("");
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [textContent, setTextContent] = useState("");
  const [textTruncated, setTextTruncated] = useState(false);
  const [sizeWarn, setSizeWarn] = useState("");
  const [versionNote, setVersionNote] = useState("");
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const textRef = useRef<HTMLPreElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLAsideElement>(null);
  const titleId = "doc-preview-title";

  const title = intent?.title || fileName || "文档预览";

  const onNumPages = useCallback((n: number) => {
    setNumPages(n);
    setPage((current) => Math.min(Math.max(1, current), n));
  }, []);

  const onPdfError = useCallback((message: string) => {
    if (message) setError(message);
  }, []);

  useEffect(() => {
    if (!intent) {
      // 关闭后清状态，避免下次打开短暂闪出上一份文档
      setLoading(false);
      setError("");
      setKind("unknown");
      setFileName("");
      setFileUrl(null);
      setPdfData(null);
      setTextContent("");
      setTextTruncated(false);
      setSizeWarn("");
      setVersionNote("");
      setPage(1);
      setNumPages(null);
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = prev;
      window.clearTimeout(focusTimer);
    };
  }, [intent]);

  useEffect(() => {
    if (!intent) return;

    let cancelled = false;

    async function load(current: DocumentPreviewIntent) {
      setLoading(true);
      setError("");
      setKind("unknown");
      setTextContent("");
      setTextTruncated(false);
      setSizeWarn("");
      setVersionNote("");
      setNumPages(null);
      setFileName(current.title || "");
      setPage(initialPage(current));
      setFileUrl(null);
      setPdfData(null);

      if (current.revisionId && current.revisionId !== "legacy") {
        setVersionNote(
          "预览为当前入库原件；若文档曾重处理，页码可能与回答引用时略有偏差。",
        );
      }

      try {
        const url = buildPreviewFileUrl(current);

        let contentType: string | null = null;
        let name = current.title || "document";
        let contentLength = 0;
        const headResponse = await fetch(url, {
          method: "HEAD",
          cache: "no-store",
        });
        if (!headResponse.ok) {
          if (
            headResponse.status === 401 ||
            headResponse.status === 403 ||
            headResponse.status === 404
          ) {
            throw new Error("无法打开原件：文件不存在或当前无权访问。");
          }
          // 405/501：少数环境可能不支持 HEAD，再走 GET 探测
          if (headResponse.status !== 405 && headResponse.status !== 501) {
            throw new Error(
              `无法打开原件（HTTP ${headResponse.status}），请稍后重试。`,
            );
          }
        } else {
          contentType = headResponse.headers.get("content-type");
          name = decodePreviewFileName(
            headResponse.headers.get("x-file-name"),
            name,
          );
          contentLength = Number(
            headResponse.headers.get("content-length") || 0,
          );
        }

        if (
          Number.isFinite(contentLength) &&
          contentLength >= PREVIEW_SIZE_WARN_BYTES
        ) {
          setSizeWarn(
            `文件约 ${formatPreviewBytes(contentLength)}，加载可能较慢。`,
          );
        }

        setFileName(name);
        const nextKind = previewKindFromMeta(contentType, name);

        if (nextKind === "pdf") {
          if (cancelled) return;
          setKind("pdf");
          // 始终保留 URL，便于渲染失败时「下载原件」
          setFileUrl(url);
          if (
            contentLength > 0 &&
            contentLength <= PREVIEW_PDF_BUFFER_MAX_BYTES
          ) {
            const bodyResponse = await fetch(url, { cache: "no-store" });
            if (!bodyResponse.ok) {
              throw new Error("无法打开原件");
            }
            const buffer = await bodyResponse.arrayBuffer();
            if (cancelled) return;
            setPdfData(buffer);
          } else {
            setPdfData(null);
          }
          return;
        }

        if (nextKind === "text") {
          const bodyResponse = await fetch(url, { cache: "no-store" });
          if (!bodyResponse.ok) throw new Error("无法读取文本原件");
          const { bytes, truncated } = await readResponsePrefix(
            bodyResponse,
            PREVIEW_TEXT_MAX_BYTES,
          );
          if (cancelled) return;
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          setKind("text");
          setFileUrl(url);
          setTextContent(
            truncated
              ? `${text}\n\n…（仅预览前 ${formatPreviewBytes(PREVIEW_TEXT_MAX_BYTES)}）`
              : text,
          );
          setTextTruncated(truncated);
          return;
        }

        // HEAD 未知或未返回元数据：单次 GET 流上 peek + 续读
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("无法打开原件（可能无权或不存在）");
        }
        if (!contentType) {
          contentType = response.headers.get("content-type");
        }
        name = decodePreviewFileName(
          response.headers.get("x-file-name"),
          name,
        );
        if (!contentLength) {
          contentLength = Number(response.headers.get("content-length") || 0);
        }
        setFileName(name);

        const resolved = await resolveOriginalFromResponse(response, {
          contentType,
          fileName: name,
          contentLength,
          textMaxBytes: PREVIEW_TEXT_MAX_BYTES,
          pdfBufferMaxBytes: PREVIEW_PDF_BUFFER_MAX_BYTES,
        });
        if (cancelled) return;

        if (resolved.kind === "pdf") {
          setKind("pdf");
          setFileUrl(url);
          if (resolved.mode === "data") {
            setPdfData(resolved.data);
          } else {
            setPdfData(null);
          }
          return;
        }

        if (resolved.kind === "text") {
          setKind("text");
          setFileUrl(url);
          setTextContent(
            resolved.truncated
              ? `${resolved.text}\n\n…（仅预览前 ${formatPreviewBytes(PREVIEW_TEXT_MAX_BYTES)}）`
              : resolved.text,
          );
          setTextTruncated(resolved.truncated);
          return;
        }

        setKind("unknown");
        setFileUrl(url);
      } catch (err) {
        if (!cancelled) {
          setError(friendlyPreviewLoadError(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(intent);
    return () => {
      cancelled = true;
    };
  }, [intent, reloadToken]);

  useEffect(() => {
    if (!intent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = [
        ...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [intent, closePreview]);

  useEffect(() => {
    if (kind !== "text" || !textContent || !intent) return;
    const raf = requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      if (
        typeof intent.startOffset === "number" &&
        Number.isFinite(intent.startOffset)
      ) {
        scrollPreToCharOffset(el, intent.startOffset);
        return;
      }
      if (typeof intent.startLine === "number" && intent.startLine >= 1) {
        scrollPreToLine(el, intent.startLine);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [intent, kind, textContent]);

  if (!intent) return null;

  const maxPage = numPages ?? null;
  const canPrev = page > 1;
  const canNext = maxPage != null && page < maxPage;
  const downloadUrl = fileUrl;

  return (
    <div
      className="doc-preview-backdrop"
      role="presentation"
      onClick={closePreview}
    >
      <aside
        ref={panelRef}
        className="doc-preview-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="doc-preview-header">
          <div className="doc-preview-heading">
            <strong id={titleId} title={title}>
              {title}
            </strong>
            {fileName && fileName !== title ? (
              <span className="doc-preview-filename">{fileName}</span>
            ) : null}
          </div>
          <div className="doc-preview-toolbar">
            {kind === "pdf" && !error ? (
              <div className="doc-preview-pager">
                <button
                  type="button"
                  className="doc-preview-page-btn"
                  disabled={!canPrev || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="上一页"
                >
                  上一页
                </button>
                <label className="doc-preview-page-input">
                  <span className="visually-hidden">页码</span>
                  <input
                    type="number"
                    min={1}
                    max={maxPage ?? undefined}
                    value={page}
                    disabled={loading || maxPage == null}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next) || next < 1) return;
                      const clamped =
                        maxPage != null
                          ? Math.min(Math.floor(next), maxPage)
                          : Math.floor(next);
                      setPage(clamped);
                    }}
                  />
                  {maxPage != null ? (
                    <span className="doc-preview-page-total">/ {maxPage}</span>
                  ) : null}
                </label>
                <button
                  type="button"
                  className="doc-preview-page-btn"
                  disabled={!canNext || loading}
                  onClick={() =>
                    setPage((p) =>
                      maxPage != null ? Math.min(p + 1, maxPage) : p + 1,
                    )
                  }
                  aria-label="下一页"
                >
                  下一页
                </button>
              </div>
            ) : null}
            {downloadUrl && !loading ? (
              <a
                className="doc-preview-page-btn"
                href={downloadUrl}
                download={fileName || "download"}
              >
                下载
              </a>
            ) : null}
            <button
              ref={closeRef}
              type="button"
              className="doc-preview-close"
              onClick={closePreview}
              aria-label="关闭预览"
            >
              <Icon name="close" />
            </button>
          </div>
        </header>

        {(sizeWarn || versionNote || textTruncated) && !error ? (
          <div className="doc-preview-banners" role="status">
            {sizeWarn ? <p>{sizeWarn}</p> : null}
            {versionNote ? <p>{versionNote}</p> : null}
            {textTruncated ? <p>文本较长，已截断预览。</p> : null}
          </div>
        ) : null}

        <div className="doc-preview-body">
          {loading ? (
            <p className="doc-preview-status">正在打开原件…</p>
          ) : error ? (
            <div className="doc-preview-status error">
              <p>{error}</p>
              <div className="doc-preview-error-actions">
                <button
                  type="button"
                  className="doc-preview-page-btn"
                  onClick={() => {
                    setError("");
                    setReloadToken((token) => token + 1);
                  }}
                >
                  重试
                </button>
                {downloadUrl ? (
                  <a
                    className="doc-preview-page-btn"
                    href={downloadUrl}
                    download={fileName || "download"}
                  >
                    下载原件
                  </a>
                ) : null}
              </div>
            </div>
          ) : kind === "pdf" && (fileUrl || pdfData) ? (
            <PdfPreviewCanvas
              cacheKey={`${intent.sourceType}:${intent.documentId}:${reloadToken}`}
              url={pdfData ? null : fileUrl}
              data={pdfData}
              page={page}
              highlightPage={
                typeof intent.page === "number" && intent.page >= 1
                  ? Math.floor(intent.page)
                  : null
              }
              highlightBbox={intent.bbox ?? null}
              highlightStart={
                typeof intent.startOffset === "number"
                  ? intent.startOffset
                  : null
              }
              highlightEnd={
                typeof intent.endOffset === "number" ? intent.endOffset : null
              }
              onNumPages={onNumPages}
              onError={onPdfError}
            />
          ) : kind === "text" ? (
            <pre ref={textRef} className="doc-preview-text">
              {textContent}
            </pre>
          ) : fileUrl ? (
            <div className="doc-preview-status">
              <p>暂不支持此格式的内嵌预览。</p>
              <a
                className="doc-preview-page-btn"
                href={fileUrl}
                download={fileName || "download"}
              >
                下载原件
              </a>
            </div>
          ) : (
            <p className="doc-preview-status">无可预览内容</p>
          )}
        </div>
      </aside>
    </div>
  );
}
