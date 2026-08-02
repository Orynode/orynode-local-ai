"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../../../services/types";
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

export function MessageBubble({
  message,
  displayName,
  thinking,
  copiedMessageId,
  onCopy,
}: MessageBubbleProps) {
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
                    a: ({ children, ...props }) => (
                      <a {...props} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {message.content}
                </Markdown>
              </div>
              {message.content.trim() && (
                <div className="message-actions">
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => onCopy(message, "txt")}
                    aria-label={copiedMessageId === `${message.id}:txt` ? "已复制文本" : "复制文本"}
                    title={copiedMessageId === `${message.id}:txt` ? "已复制文本" : "复制纯文本"}
                  >
                    <Icon name={copiedMessageId === `${message.id}:txt` ? "check" : "copy"} />
                    <span>{copiedMessageId === `${message.id}:txt` ? "已复制" : "复制 TXT"}</span>
                  </button>
                  <button
                    type="button"
                    className="message-action"
                    onClick={() => onCopy(message, "md")}
                    aria-label={copiedMessageId === `${message.id}:md` ? "已复制 Markdown" : "复制 Markdown"}
                    title={copiedMessageId === `${message.id}:md` ? "已复制 Markdown" : "复制 Markdown"}
                  >
                    <Icon name={copiedMessageId === `${message.id}:md` ? "check" : "copy"} />
                    <span>{copiedMessageId === `${message.id}:md` ? "已复制" : "复制 MD"}</span>
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
