"use client";

import { useCallback, useRef, useState } from "react";
import type {
  Message,
  MessageAttachment,
  MessageCitation,
} from "../../services/types";
import { extractReferencedCitationIds } from "../../services/chat/prompt";
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
  /** 切换会话 / 新对话时递增，丢弃过期流式更新与落库 */
  const runIdRef = useRef(0);

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

  /** 中止当前生成并作废 run，不改 messages（切历史 / 删会话用） */
  const discardActiveRun = useCallback(() => {
    runIdRef.current += 1;
    cancelledRef.current = true;
    abortController.current?.abort();
    abortController.current = null;
    setSending(false);
    setError("");
  }, []);

  const clearChat = useCallback(() => {
    discardActiveRun();
    setMessages([]);
  }, [discardActiveRun]);

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
      const runId = ++runIdRef.current;
      const isCurrent = () => runId === runIdRef.current;

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
      let streamError: string | null = null;
      let providedCitations: MessageCitation[] = [];
      let referencedCitationIds: string[] = [];
      let retrievalTraceId: string | undefined;
      let retrievalDiagnostics: Message["retrievalDiagnostics"];
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

        if (isCurrent()) setConnected(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const buildAssistant = (text: string): Message => ({
          ...assistantMessage,
          content: text,
          ...(providedCitations.length > 0
            ? { citations: providedCitations }
            : {}),
          ...(referencedCitationIds.length > 0
            ? { referencedCitationIds }
            : {}),
          ...(retrievalTraceId ? { retrievalTraceId } : {}),
          ...(retrievalDiagnostics ? { retrievalDiagnostics } : {}),
        });

        try {
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";

            for (const event of events) {
              let eventName = "message";
              for (const line of event.split("\n")) {
                if (line.startsWith("event:")) {
                  eventName = line.slice(6).trim();
                  continue;
                }
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                const chunk = JSON.parse(data);

                // Orynode SSE v1
                if (
                  eventName === "metadata" ||
                  (chunk?.version === 1 && Array.isArray(chunk.providedCitations))
                ) {
                  providedCitations = Array.isArray(chunk.providedCitations)
                    ? chunk.providedCitations
                    : [];
                  retrievalTraceId =
                    typeof chunk.traceId === "string"
                      ? chunk.traceId
                      : undefined;
                  retrievalDiagnostics = chunk.diagnostics ?? undefined;
                  continue;
                }

                if (
                  eventName === "delta" ||
                  (chunk?.version === 1 && typeof chunk.text === "string")
                ) {
                  if (typeof chunk.text === "string" && chunk.text) {
                    answer += chunk.text;
                    if (isCurrent()) {
                      setMessages([...nextMessages, buildAssistant(answer)]);
                    }
                  }
                  continue;
                }

                if (eventName === "usage") {
                  continue;
                }

                if (eventName === "error") {
                  const message =
                    typeof chunk.message === "string"
                      ? chunk.message
                      : typeof chunk.error === "string"
                        ? chunk.error
                        : "模型流错误";
                  streamError = message;
                  if (isCurrent()) setError(message);
                  continue;
                }

                if (
                  eventName === "done" ||
                  (chunk?.version === 1 &&
                    Array.isArray(chunk.referencedCitationIds))
                ) {
                  referencedCitationIds = Array.isArray(
                    chunk.referencedCitationIds,
                  )
                    ? chunk.referencedCitationIds
                    : [];
                  continue;
                }

                // 短期兼容：旧 orynode 包络 + OpenAI choices
                if (chunk?.orynode?.type === "metadata") {
                  providedCitations = Array.isArray(
                    chunk.orynode.providedCitations,
                  )
                    ? chunk.orynode.providedCitations
                    : [];
                  retrievalTraceId =
                    typeof chunk.orynode.retrievalTraceId === "string"
                      ? chunk.orynode.retrievalTraceId
                      : undefined;
                  retrievalDiagnostics = chunk.orynode.diagnostics ?? undefined;
                  continue;
                }

                if (chunk?.orynode?.type === "done") {
                  referencedCitationIds = Array.isArray(
                    chunk.orynode.referencedCitationIds,
                  )
                    ? chunk.orynode.referencedCitationIds
                    : [];
                  continue;
                }

                const delta = chunk.choices?.[0]?.delta?.content;
                if (typeof delta !== "string" || !delta) continue;
                answer += delta;
                if (isCurrent()) {
                  setMessages([...nextMessages, buildAssistant(answer)]);
                }
              }
            }
            if (done) break;
          }
        } finally {
          reader.cancel().catch(() => {
            // reader may already be cancelled/errored after abort
          });
        }

        if (!isCurrent()) return null;

        if (
          referencedCitationIds.length === 0 &&
          providedCitations.length > 0 &&
          answer
        ) {
          referencedCitationIds = extractReferencedCitationIds(
            answer,
            providedCitations.map((item) => item.id),
          );
        }

        // 流中报错且无任何输出：按失败回滚，不落幽灵用户消息
        if (streamError && !answer) {
          throw new Error(streamError);
        }

        const completed: Message[] = answer
          ? [
              ...nextMessages,
              {
                ...buildAssistant(answer),
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
          if (!isCurrent()) return null;
          activeId = saved.id;
        } catch {
          // UI 已更新；持久化失败不回滚本轮可见回复
        }

        return isCurrent() ? { id: activeId ?? "", title: nextTitle } : null;
      } catch (e) {
        if (!isCurrent()) return null;

        if (
          cancelledRef.current ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          if (
            referencedCitationIds.length === 0 &&
            providedCitations.length > 0 &&
            answer
          ) {
            referencedCitationIds = extractReferencedCitationIds(
              answer,
              providedCitations.map((item) => item.id),
            );
          }
          const completed: Message[] = answer
            ? [
                ...nextMessages,
                {
                  ...assistantMessage,
                  content: answer,
                  durationMs: Math.round(performance.now() - startedAt),
                  ...(providedCitations.length > 0
                    ? { citations: providedCitations }
                    : {}),
                  ...(referencedCitationIds.length > 0
                    ? { referencedCitationIds }
                    : {}),
                  ...(retrievalTraceId ? { retrievalTraceId } : {}),
                  ...(retrievalDiagnostics ? { retrievalDiagnostics } : {}),
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
            if (!isCurrent()) return null;
            activeId = saved.id;
          } catch {
            // ignore
          }
          return isCurrent() ? { id: activeId ?? "", title: nextTitle } : null;
        }
        // 推理失败：仅回滚 UI；DB 未写入本轮用户消息
        setMessages(messages);
        const message =
          e instanceof Error ? e.message : "无法连接本地模型";
        setError(message);
        // 仅网络/连接类失败时标离线，避免业务错误误伤状态点
        if (
          /连接|不可用|Failed to fetch|network|ECONNREFUSED/i.test(message)
        ) {
          setConnected(false);
        }
        return null;
      } finally {
        if (isCurrent()) {
          cancelledRef.current = false;
          abortController.current = null;
          setSending(false);
        }
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
    discardActiveRun,
    clearChat,
  };
}
