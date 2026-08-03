"use client";

import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, MessageCitation } from "../../../services/types";
import { Icon } from "../ui/Icon";

export function BrandLogo() {
  return (
    <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />
  );
}

interface MessageBubbleProps {
  message: Message;
  displayName: string;
  thinking: boolean;
  copiedMessageId: string | null;
  onCopy: (message: Message, format: "txt" | "md") => void;
}

function linkCitationMarkers(
  content: string,
  citations: MessageCitation[] | undefined,
): string {
  if (!citations || citations.length === 0) return content;
  const allowed = new Set(citations.map((item) => item.id));
  return content.replace(/\[(S\d+)\]/g, (full, id: string) =>
    allowed.has(id) ? `[${id}](citation:${id})` : full,
  );
}

function locatorLabel(citation: MessageCitation): string {
  const locator = citation.locator;
  if (!locator || typeof locator !== "object" || !("kind" in locator)) {
    return "原文位置";
  }
  if (locator.kind === "page" && typeof (locator as { page?: unknown }).page === "number") {
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

export function MessageBubble({
  message,
  displayName,
  thinking,
  copiedMessageId,
  onCopy,
}: MessageBubbleProps) {
  const [activeCitationId, setActiveCitationId] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const markdown = useMemo(
    () => linkCitationMarkers(message.content, message.citations),
    [message.content, message.citations],
  );

  const referenced = new Set(message.referencedCitationIds ?? []);
  const citations = message.citations ?? [];

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
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ children, href, ...props }) => {
                      if (href?.startsWith("citation:")) {
                        const id = href.slice("citation:".length);
                        return (
                          <button
                            type="button"
                            className={`cite-ref${
                              activeCitationId === id ? " active" : ""
                            }`}
                            onClick={() =>
                              setActiveCitationId((current) =>
                                current === id ? null : id,
                              )
                            }
                          >
                            {children}
                          </button>
                        );
                      }
                      return (
                        <a {...props} href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {markdown}
                </Markdown>
              </div>

              {citations.length > 0 || message.retrievalDiagnostics ? (
                <div className="message-sources" aria-label="回答来源">
                  {citations.length > 0 ? (
                    <>
                      <div className="message-sources-title">来源</div>
                      <ul className="message-source-list">
                        {citations.map((citation) => {
                          const isReferenced = referenced.has(citation.id);
                          const isActive = activeCitationId === citation.id;
                          return (
                            <li
                              key={citation.id}
                              className={`message-source-card${
                                isReferenced ? " referenced" : ""
                              }${isActive ? " active" : ""}`}
                            >
                              <button
                                type="button"
                                className="message-source-button"
                                onClick={() =>
                                  setActiveCitationId((current) =>
                                    current === citation.id ? null : citation.id,
                                  )
                                }
                              >
                                <span className="message-source-id">
                                  {citation.id}
                                </span>
                                <span className="message-source-meta">
                                  <strong>{citation.title}</strong>
                                  <span>
                                    {citation.sourceType === "conversation_file"
                                      ? "本对话附件"
                                      : "资料库"}
                                    · {locatorLabel(citation)}
                                    {isReferenced ? " · 已引用" : " · 已提供"}
                                  </span>
                                </span>
                              </button>
                              {isActive ? (
                                <p className="message-source-excerpt">
                                  {citation.excerpt}
                                </p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : (
                    <div className="message-sources-title">检索未命中</div>
                  )}
                  {message.retrievalDiagnostics ? (
                    <div className="message-diagnostics">
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
                  ) : null}
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
