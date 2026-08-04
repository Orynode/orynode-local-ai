"use client";

import { useRef, useLayoutEffect } from "react";
import type { Message } from "../../../services/types";
import { MessageBubble } from "./MessageBubble";

interface ChatViewProps {
  messages: Message[];
  sending: boolean;
  displayName: string;
  copiedMessageId: string | null;
  conversationId?: string | null;
  onCopy: (message: Message, format: "txt" | "md") => void;
}

export function ChatView({
  messages,
  sending,
  displayName,
  copiedMessageId,
  conversationId = null,
  onCopy,
}: ChatViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  function isNearBottom(el: HTMLElement, threshold = 96) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, sending]);

  return (
    <div
      className="conversation"
      ref={ref}
      onScroll={(event) => {
        stickToBottom.current = isNearBottom(event.currentTarget);
      }}
    >
      <div className="messages" aria-live="polite">
        {messages.map((message, index) => {
          const thinking =
            sending &&
            message.role === "assistant" &&
            index === messages.length - 1 &&
            !message.content.trim();

          return (
            <MessageBubble
              key={message.id}
              message={message}
              displayName={displayName}
              thinking={thinking}
              copiedMessageId={copiedMessageId}
              conversationId={conversationId}
              onCopy={onCopy}
            />
          );
        })}
      </div>
    </div>
  );
}
