"use client";

import { useCallback, useRef, useState } from "react";
import type { Message, MessageAttachment } from "../../services/types";
import { scopeFromAttachments } from "../lib/attachments";

export type { Message };

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState("Gemma 4 26B A4B IT");
  const abortController = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  const checkStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const result = await response.json();
      setConnected(Boolean(result.connected));
      if (result.modelName) setModelName(result.modelName);
    } catch {
      setConnected(false);
    }
  }, []);

  const stopGeneration = useCallback(() => {
    cancelledRef.current = true;
    abortController.current?.abort();
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    setError("");
  }, []);

  const sendMessage = useCallback(
    async (
      content: string,
      conversationId: string | null,
      conversationTitle: string,
      attachments: MessageAttachment[] | undefined,
      temperature: number,
      topP: number,
      topK: number,
      maxTokens: number,
      maxContext: number,
      onConversationSaved: (
        messages: Message[],
        title: string,
        id: string | null,
      ) => Promise<{ id: string; title: string }>,
    ) => {
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const nextMessages = [...messages, userMessage];
      const nextTitle =
        conversationTitle || content.replace(/\s+/g, " ").slice(0, 32);

      // 推理成功/停止后再持久化用户消息，避免失败留下幽灵气泡
      let activeId = conversationId;
      const retrievalScope = scopeFromAttachments(attachments, activeId);
      cancelledRef.current = false;
      const controller = new AbortController();
      abortController.current = controller;

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      };
      let answer = "";
      const startedAt = performance.now();

      setMessages([...nextMessages, assistantMessage]);
      setSending(true);
      setError("");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages.map(({ role, content: text }) => ({
              role,
              content: text,
            })),
            conversationId: activeId,
            retrievalScope,
            temperature,
            topP,
            topK,
            maxTokens,
            maxContext,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || "本地模型暂时不可用");
        }
        if (!response.body) throw new Error("本地模型没有返回可读取的内容");

        setConnected(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";

            for (const event of events) {
              for (const line of event.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                const chunk = JSON.parse(data);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta !== "string" || !delta) continue;
                answer += delta;
                setMessages([
                  ...nextMessages,
                  { ...assistantMessage, content: answer },
                ]);
              }
            }
            if (done) break;
          }
        } finally {
          reader.cancel().catch(() => {
            // reader may already be cancelled/errored after abort
          });
        }

        const completed: Message[] = answer
          ? [
              ...nextMessages,
              {
                ...assistantMessage,
                content: answer,
                durationMs: Math.round(performance.now() - startedAt),
              },
            ]
          : nextMessages;

        setMessages(completed);
        try {
          const saved = await onConversationSaved(
            completed,
            nextTitle,
            activeId,
          );
          activeId = saved.id;
        } catch {
          // UI 已更新；持久化失败不回滚本轮可见回复
        }

        return { id: activeId ?? "", title: nextTitle };
      } catch (e) {
        if (
          cancelledRef.current ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          const completed: Message[] = answer
            ? [
                ...nextMessages,
                {
                  ...assistantMessage,
                  content: answer,
                  durationMs: Math.round(performance.now() - startedAt),
                },
              ]
            : nextMessages;
          setMessages(completed);
          try {
            const saved = await onConversationSaved(
              completed,
              nextTitle,
              activeId,
            );
            activeId = saved.id;
          } catch {
            // ignore
          }
          return { id: activeId ?? "", title: nextTitle };
        }
        // 推理失败：仅回滚 UI；DB 未写入本轮用户消息
        setMessages(messages);
        setConnected(false);
        setError(e instanceof Error ? e.message : "无法连接本地模型");
        return null;
      } finally {
        cancelledRef.current = false;
        abortController.current = null;
        setSending(false);
      }
    },
    [messages],
  );

  return {
    messages,
    setMessages,
    sending,
    error,
    setError,
    connected,
    modelName,
    sendMessage,
    checkStatus,
    stopGeneration,
    clearChat,
  };
}
