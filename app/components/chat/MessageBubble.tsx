"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentPropsWithoutRef, CSSProperties } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, MessageCitation } from "../../../services/types";
import {
  citationIdsFromHref,
  citationUrlTransform,
  prepareAssistantCitationMarkdown,
} from "../../lib/citation-markdown";
import {
  previewIntentFromCitation,
  useDocumentPreview,
  webUrlFromCitation,
} from "../../lib/document-preview";
import { Icon } from "../ui/Icon";
import { summarizeDegradedReasons } from "../../../services/knowledge/retrieval/degraded-labels";

/** 引用胶囊 UI 状态；必须用稳定的 Markdown `a` 组件读取，避免每次渲染换函数类型导致 remount */
const CitationUiContext = createContext<{
  citationById: Map<string, MessageCitation>;
  activeChipId: string | null;
  setActiveChipId: (chipId: string | null) => void;
  conversationId: string | null;
} | null>(null);

export function BrandLogo() {
  return (
    // 静态本地 SVG，无需 next/image 优化管线
    // eslint-disable-next-line @next/next/no-img-element -- brand mark from /public
    <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
  );
}

interface MessageBubbleProps {
  message: Message;
  displayName: string;
  thinking: boolean;
  copiedMessageId: string | null;
  /** 会话附件「查看原文」需要绑定当前会话 */
  conversationId?: string | null;
  onCopy: (message: Message, format: "txt" | "md") => void;
}

function locatorLabel(citation: MessageCitation): string {
  const locator = citation.locator;
  if (!locator || typeof locator !== "object" || !("kind" in locator)) {
    return "原文位置";
  }
  if (
    locator.kind === "page" &&
    typeof (locator as { page?: unknown }).page === "number"
  ) {
    const page = locator as {
      page: number;
      startOffset?: number;
      endOffset?: number;
    };
    const range =
      page.startOffset != null && page.endOffset != null
        ? ` · 字符 ${page.startOffset}-${page.endOffset}`
        : "";
    return `第 ${page.page} 页${range}`;
  }
  if (locator.kind === "markdown") {
    const md = locator as {
      headingPath?: string[];
      startLine?: number;
      endLine?: number;
    };
    const heading = md.headingPath?.length
      ? md.headingPath.join(" / ")
      : "Markdown";
    const lines =
      md.startLine != null && md.endLine != null
        ? ` L${md.startLine}-${md.endLine}`
        : "";
    return `${heading}${lines}`;
  }
  if (locator.kind === "web") {
    const web = locator as {
      url?: string;
      headingPath?: string[];
      textFragment?: string;
    };
    if (web.headingPath?.length) return web.headingPath.join(" / ");
    if (web.textFragment) return web.textFragment;
    return web.url || "网页";
  }
  if (locator.kind === "code") {
    const code = locator as {
      repo?: string;
      path?: string;
      commit?: string;
      startLine?: number;
      endLine?: number;
    };
    const lines =
      code.startLine && code.endLine
        ? `:${code.startLine}-${code.endLine}`
        : "";
    return `${code.repo || ""}/${code.path || ""}${lines}`.replace(/^\//, "");
  }
  return "原文位置";
}

/** 用户可见的文档短名（去掉路径与扩展名）；S# 仅协议内部编号，不直接展示 */
function citationDocLabel(
  citation: MessageCitation | undefined,
  fallback = "资料",
): string {
  const raw = citation?.title?.trim();
  if (!raw) return fallback;
  const base = raw.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  if (!base) return fallback;
  return base;
}

/** 胶囊内文案：过长交给 CSS ellipsis；这里只做轻度上限，避免极端长串撑布局 */
function citationChipLabel(
  citation: MessageCitation | undefined,
  fallback = "资料",
): string {
  const label = citationDocLabel(citation, fallback);
  const chars = Array.from(label);
  if (chars.length <= 12) return label;
  return `${chars.slice(0, 11).join("")}…`;
}

function CiteRefChip({
  citationIds,
  citationsById,
  activeChipId,
  onActivate,
  conversationId,
}: {
  citationIds: string[];
  citationsById: Map<string, MessageCitation>;
  activeChipId: string | null;
  onActivate: (chipId: string | null) => void;
  conversationId: string | null;
}) {
  const chipId = useId();
  const active = activeChipId === chipId;
  const { openPreview } = useDocumentPreview();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  const items = citationIds.map((id) => ({
    id,
    citation: citationsById.get(id),
  }));
  const isGroup = citationIds.length > 1;

  const avatarDocs: MessageCitation[] = [];
  const seenDoc = new Set<string>();
  for (const { citation } of items) {
    if (!citation) continue;
    const key = `${citation.sourceType}:${citation.documentId || citation.title}`;
    if (seenDoc.has(key)) continue;
    seenDoc.add(key);
    avatarDocs.push(citation);
    if (avatarDocs.length >= 3) break;
  }

  const single = items[0];
  const singleCitation = single?.citation;
  const chipLabel = isGroup
    ? avatarDocs.length === 1
      ? citationChipLabel(avatarDocs[0])
      : "来源"
    : citationChipLabel(singleCitation);
  const fullTitle =
    (isGroup && avatarDocs.length === 1
      ? avatarDocs[0]?.title
      : singleCitation?.title) || chipLabel;
  const ariaLabel = isGroup
    ? `查看 ${citationIds.length} 条引用依据`
    : `查看来源：${fullTitle}`;

  const citationIdsKey = citationIds.join(",");

  useLayoutEffect(() => {
    if (!active || !wrapRef.current || !popoverRef.current) {
      setPopoverStyle(null);
      return;
    }

    const place = () => {
      const chip = wrapRef.current?.getBoundingClientRect();
      const pop = popoverRef.current;
      if (!chip || !pop) return;

      const width = Math.min(320, window.innerWidth - 16);
      const gap = 8;
      const spaceBelow = window.innerHeight - chip.bottom - gap;
      const spaceAbove = chip.top - gap;
      const placeAbove =
        spaceBelow < Math.min(280, spaceAbove) && spaceAbove > 120;
      const maxHeight = Math.max(
        140,
        Math.min(420, placeAbove ? spaceAbove : spaceBelow),
      );

      pop.style.width = `${width}px`;
      pop.style.maxHeight = `${maxHeight}px`;
      const height = Math.min(pop.scrollHeight, maxHeight);

      let top = placeAbove ? chip.top - gap - height : chip.bottom + gap;
      let left = chip.left;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

      setPopoverStyle({
        position: "fixed",
        top,
        left,
        width,
        maxHeight,
      });
    };

    place();
    // 内容撑开后再量一次，避免首次高度不准
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, citationIdsKey]);

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      onActivate(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onActivate(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, onActivate]);

  const popover = active
    ? createPortal(
        <div
          ref={popoverRef}
          className="cite-ref-popover"
          role="dialog"
          aria-label={ariaLabel}
          style={popoverStyle ?? { visibility: "hidden" }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {items.map(({ id, citation }) => {
            const isFile = citation?.sourceType === "conversation_file";
            const sourceLabel = isFile ? "本对话附件" : "资料库";
            const tipTitle = citationDocLabel(citation, citation?.title || "资料");
            const tipLoc = citation ? locatorLabel(citation) : "原文位置";
            const tipExcerpt = citation?.excerpt?.trim() || "";
            const webUrl = citation ? webUrlFromCitation(citation) : null;
            const canOpenOriginal =
              Boolean(citation?.documentId) &&
              (citation?.sourceType !== "conversation_file" ||
                Boolean(conversationId)) &&
              !webUrl;
            return (
              <div key={id} className="cite-ref-popover-item">
                <div className="cite-ref-popover-head">
                  <span className="cite-ref-popover-icon" aria-hidden="true">
                    <Icon name={isFile ? "attach" : "database"} />
                  </span>
                  <span className="cite-ref-popover-source">{sourceLabel}</span>
                </div>
                <strong className="cite-ref-popover-title">
                  {citation?.title || tipTitle}
                </strong>
                <span className="cite-ref-popover-meta">{tipLoc}</span>
                {tipExcerpt ? (
                  <span className="cite-ref-popover-excerpt">{tipExcerpt}</span>
                ) : null}
                {webUrl ? (
                  <a
                    className="cite-ref-popover-action"
                    href={webUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => onActivate(null)}
                  >
                    打开网页
                  </a>
                ) : canOpenOriginal && citation ? (
                  <button
                    type="button"
                    className="cite-ref-popover-action"
                    onClick={() => {
                      const intent = previewIntentFromCitation(
                        citation,
                        conversationId,
                      );
                      if (!intent) return;
                      onActivate(null);
                      openPreview(intent);
                    }}
                  >
                    查看原文
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <span
      ref={wrapRef}
      className={`cite-ref-wrap${active ? " active" : ""}`}
    >
      <button
        type="button"
        className="cite-ref"
        aria-label={ariaLabel}
        title={fullTitle}
        aria-expanded={active}
        aria-haspopup="dialog"
        onClick={() => onActivate(active ? null : chipId)}
      >
        {isGroup && avatarDocs.length > 0 ? (
          <span className="cite-ref-avatars" aria-hidden="true">
            {avatarDocs.map((doc) => (
              <span
                key={`${doc.sourceType}:${doc.documentId || doc.title}`}
                className={`cite-ref-avatar ${
                  doc.sourceType === "conversation_file" ? "file" : "library"
                }`}
              >
                <Icon
                  name={
                    doc.sourceType === "conversation_file"
                      ? "attach"
                      : "database"
                  }
                />
              </span>
            ))}
          </span>
        ) : (
          <span className="cite-ref-icon" aria-hidden="true">
            <Icon
              name={
                singleCitation?.sourceType === "conversation_file"
                  ? "attach"
                  : "database"
              }
            />
          </span>
        )}
        <span className="cite-ref-id">{chipLabel}</span>
        {isGroup ? (
          <span className="cite-ref-count">{citationIds.length}</span>
        ) : null}
      </button>
      {popover}
    </span>
  );
}

/** 模块级稳定引用：勿在 MessageBubble 内联定义，否则打开弹层会 remount 胶囊 */
function MarkdownCitationAnchor({
  children,
  href,
  ...props
}: ComponentPropsWithoutRef<"a">) {
  const ctx = useContext(CitationUiContext);
  const ids = citationIdsFromHref(href);
  if (ctx && ids.length > 0) {
    return (
      <CiteRefChip
        citationIds={ids}
        citationsById={ctx.citationById}
        activeChipId={ctx.activeChipId}
        onActivate={ctx.setActiveChipId}
        conversationId={ctx.conversationId}
      />
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const markdownComponents = { a: MarkdownCitationAnchor };

export function MessageBubble({
  message,
  displayName,
  thinking,
  copiedMessageId,
  conversationId = null,
  onCopy,
}: MessageBubbleProps) {
  const [activeChipId, setActiveChipId] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const markdown = useMemo(
    () => prepareAssistantCitationMarkdown(message.content, message.citations),
    [message.content, message.citations],
  );

  const citationById = useMemo(() => {
    const map = new Map<string, MessageCitation>();
    for (const item of message.citations ?? []) map.set(item.id, item);
    return map;
  }, [message.citations]);

  const citationUi = useMemo(
    () => ({
      citationById,
      activeChipId,
      setActiveChipId,
      conversationId,
    }),
    [citationById, activeChipId, conversationId],
  );

  return (
    <article
      className={`message ${message.role}${thinking ? " thinking" : ""}`}
      data-message-id={message.id}
    >
      <div className="message-meta">
        <span className="message-avatar" aria-hidden="true">
          {message.role === "user" ? <Icon name="robot" /> : <BrandLogo />}
        </span>
        <strong>
          {message.role === "user" ? displayName : "Orynode Local AI"}
        </strong>
      </div>
      <div className="message-body">
        {message.role === "assistant" ? (
          thinking ? (
            <p className="waiting-hint">🤯 正在一本正经地胡思乱想…</p>
          ) : (
            <>
              <div className="message-markdown">
                <CitationUiContext.Provider value={citationUi}>
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    urlTransform={citationUrlTransform}
                    components={markdownComponents}
                  >
                    {markdown}
                  </Markdown>
                </CitationUiContext.Provider>
              </div>

              {message.retrievalDiagnostics ? (
                <div className="message-sources" aria-label="检索诊断">
                  <div className="message-diagnostics">
                    {(() => {
                      const degradedSummary = summarizeDegradedReasons(
                        message.retrievalDiagnostics.degradedReasons ??
                          message.retrievalDiagnostics.degradedCapabilities,
                      );
                      const tierHint =
                        message.retrievalDiagnostics.requestedTier &&
                        message.retrievalDiagnostics.effectiveTier &&
                        message.retrievalDiagnostics.requestedTier !==
                          message.retrievalDiagnostics.effectiveTier
                          ? `请求 ${message.retrievalDiagnostics.requestedTier} → 实际 ${message.retrievalDiagnostics.effectiveTier}`
                          : null;
                      if (!degradedSummary && !tierHint) return null;
                      return (
                        <p className="message-diagnostics-summary">
                          {degradedSummary
                            ? `检索降级：${degradedSummary}`
                            : null}
                          {degradedSummary && tierHint ? " · " : null}
                          {tierHint}
                        </p>
                      );
                    })()}
                    <button
                      type="button"
                      className="message-diagnostics-toggle"
                      onClick={() => setShowDiagnostics((value) => !value)}
                    >
                      {showDiagnostics ? "隐藏检索诊断" : "检索诊断"}
                    </button>
                    {showDiagnostics ? (
                      <pre className="message-diagnostics-body">
                        {JSON.stringify(message.retrievalDiagnostics, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {message.content.trim() && (
                <div className="message-actions">
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => onCopy(message, "txt")}
                    aria-label={
                      copiedMessageId === `${message.id}:txt`
                        ? "已复制文本"
                        : "复制文本"
                    }
                    title={
                      copiedMessageId === `${message.id}:txt`
                        ? "已复制文本"
                        : "复制纯文本"
                    }
                  >
                    <Icon
                      name={
                        copiedMessageId === `${message.id}:txt`
                          ? "check"
                          : "copy"
                      }
                    />
                    <span>
                      {copiedMessageId === `${message.id}:txt`
                        ? "已复制"
                        : "复制 TXT"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => onCopy(message, "md")}
                    aria-label={
                      copiedMessageId === `${message.id}:md`
                        ? "已复制 Markdown"
                        : "复制 Markdown"
                    }
                    title={
                      copiedMessageId === `${message.id}:md`
                        ? "已复制 Markdown"
                        : "复制 Markdown"
                    }
                  >
                    <Icon
                      name={
                        copiedMessageId === `${message.id}:md`
                          ? "check"
                          : "copy"
                      }
                    />
                    <span>
                      {copiedMessageId === `${message.id}:md`
                        ? "已复制"
                        : "复制 MD"}
                    </span>
                  </button>
                  {typeof message.durationMs === "number" && (
                    <span className="message-duration">
                      耗时 {formatDuration(message.durationMs)}
                    </span>
                  )}
                </div>
              )}
            </>
          )
        ) : (
          <div className="message-bubble">
            {message.attachments && message.attachments.length > 0 ? (
              <div className="message-attachments" aria-label="附带资料">
                {message.attachments.map((item) => (
                  <div
                    key={`${item.kind}:${item.id}`}
                    className="message-attachment"
                  >
                    <span className="message-attachment-icon" aria-hidden>
                      <Icon
                        name={
                          item.kind === "library_all" ? "database" : "attach"
                        }
                      />
                    </span>
                    <span className="message-attachment-name">
                      {item.kind === "conversation_file"
                        ? `${item.name}（本对话）`
                        : item.name}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <p>{message.content}</p>
          </div>
        )}
      </div>
    </article>
  );
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return `${minutes} 分 ${remain} 秒`;
}
