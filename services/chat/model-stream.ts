/**
 * 内部模型流事件：adapter 把后端协议转成此形状，Chat 再编码为 Orynode SSE。
 */

export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
    }
  | {
      type: "error";
      code: string;
      message?: string;
      recoverable?: boolean;
    }
  | { type: "done"; finishReason?: string };

/**
 * 将 OpenAI 兼容 chat.completions SSE bytes 转为内部 ModelStreamEvent。
 */
export function openAiChatStreamToModelEvents(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<ModelStreamEvent> {
  return new ReadableStream<ModelStreamEvent>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let emittedDone = false;

      const emitDone = (finishReason?: string) => {
        if (emittedDone) return;
        emittedDone = true;
        controller.enqueue({
          type: "done",
          finishReason: finishReason ?? "stop",
        });
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              for (const line of part.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                if (data === "[DONE]") {
                  emitDone("stop");
                  continue;
                }
                try {
                  const chunk = JSON.parse(data) as {
                    choices?: Array<{
                      delta?: { content?: string };
                      finish_reason?: string | null;
                    }>;
                    usage?: {
                      prompt_tokens?: number;
                      completion_tokens?: number;
                    };
                    error?: { message?: string; code?: string };
                  };
                  if (chunk.error) {
                    controller.enqueue({
                      type: "error",
                      code: chunk.error.code || "MODEL_ERROR",
                      message: chunk.error.message,
                      recoverable: true,
                    });
                    continue;
                  }
                  const choice = chunk.choices?.[0];
                  const delta = choice?.delta?.content;
                  if (typeof delta === "string" && delta) {
                    controller.enqueue({ type: "delta", text: delta });
                  }
                  if (chunk.usage) {
                    controller.enqueue({
                      type: "usage",
                      inputTokens: chunk.usage.prompt_tokens,
                      outputTokens: chunk.usage.completion_tokens,
                    });
                  }
                  if (choice?.finish_reason) {
                    emitDone(choice.finish_reason);
                  }
                } catch {
                  // ignore malformed upstream chunks
                }
              }
            }
          }
          if (done) break;
        }
        emitDone("stop");
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "MODEL_STREAM_FAILED";
        const aborted =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");
        controller.enqueue({
          type: "error",
          code: aborted ? "MODEL_ABORTED" : "MODEL_STREAM_FAILED",
          message,
          recoverable: aborted,
        });
        emitDone(aborted ? "cancelled" : "error");
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/** 测试用：任意后端事件源的透传 helper */
export function modelEventsFromAsync(
  events: AsyncIterable<ModelStreamEvent>,
): ReadableStream<ModelStreamEvent> {
  return new ReadableStream<ModelStreamEvent>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(event);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
