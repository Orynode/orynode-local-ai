/**
 * Orynode Chat SSE v1 包络
 *
 * event: metadata | delta | usage | error | done
 * data:  {"version":1,...}
 *
 * Model adapter → ModelStreamEvent；本模块只负责编码，不解析 OpenAI choices。
 */

import type { Citation, RetrievalDiagnostics } from "../knowledge/core/types";
import {
  openAiChatStreamToModelEvents,
  type ModelStreamEvent,
} from "./model-stream";

export const ORYNODE_SSE_VERSION = 1 as const;

export type OrynodeSseMetadata = {
  version: typeof ORYNODE_SSE_VERSION;
  traceId: string;
  providedCitations: Citation[];
  diagnostics: RetrievalDiagnostics | null;
  capabilities?: Record<string, unknown>;
};

export type OrynodeSseDone = {
  version: typeof ORYNODE_SSE_VERSION;
  referencedCitationIds: string[];
  finishReason?: string;
};

export function encodeSseEvent(
  event: string,
  payload: unknown,
): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

export function wrapModelStreamAsOrynodeSse(
  modelEvents: ReadableStream<ModelStreamEvent>,
  metadata: OrynodeSseMetadata,
  options?: {
    onComplete?: (fullText: string) => {
      referencedCitationIds: string[];
      finishReason?: string;
    };
    onFinally?: () => void;
  },
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encodeSseEvent("metadata", {
          version: ORYNODE_SSE_VERSION,
          traceId: metadata.traceId,
          providedCitations: metadata.providedCitations,
          diagnostics: metadata.diagnostics,
          capabilities: metadata.capabilities ?? {},
        }),
      );

      const reader = modelEvents.getReader();
      let answer = "";
      let finishReason = "stop";
      let sawDone = false;
      let sawError = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (value) {
            if (value.type === "delta") {
              answer += value.text;
              controller.enqueue(
                encodeSseEvent("delta", {
                  version: ORYNODE_SSE_VERSION,
                  text: value.text,
                }),
              );
            } else if (value.type === "usage") {
              controller.enqueue(
                encodeSseEvent("usage", {
                  version: ORYNODE_SSE_VERSION,
                  inputTokens: value.inputTokens ?? 0,
                  outputTokens: value.outputTokens ?? 0,
                  durationMs: value.durationMs ?? 0,
                }),
              );
            } else if (value.type === "error") {
              sawError = true;
              controller.enqueue(
                encodeSseEvent("error", {
                  version: ORYNODE_SSE_VERSION,
                  code: value.code,
                  message: value.message,
                  recoverable: value.recoverable ?? false,
                }),
              );
            } else if (value.type === "done") {
              finishReason = value.finishReason ?? (sawError ? "error" : "stop");
              sawDone = true;
            }
          }
          if (done) break;
        }

        if (!sawDone) {
          finishReason = sawError ? "error" : "stop";
        }

        const doneExtra = options?.onComplete?.(answer);
        controller.enqueue(
          encodeSseEvent("done", {
            version: ORYNODE_SSE_VERSION,
            referencedCitationIds: doneExtra?.referencedCitationIds ?? [],
            finishReason: doneExtra?.finishReason ?? finishReason,
          }),
        );
        controller.close();
      } catch (error) {
        controller.enqueue(
          encodeSseEvent("error", {
            version: ORYNODE_SSE_VERSION,
            code: "SSE_ENCODE_FAILED",
            message: error instanceof Error ? error.message : "stream failed",
            recoverable: false,
          }),
        );
        controller.enqueue(
          encodeSseEvent("done", {
            version: ORYNODE_SSE_VERSION,
            referencedCitationIds: [],
            finishReason: "error",
          }),
        );
        controller.close();
      } finally {
        reader.releaseLock();
        options?.onFinally?.();
      }
    },
  });
}

/**
 * OpenAI 兼容 upstream bytes → Orynode SSE v1（Chat route 入口）
 */
export function wrapChatStreamWithMetadata(
  upstream: ReadableStream<Uint8Array>,
  metadata: {
    type?: "metadata";
    providedCitations: Citation[];
    retrievalTraceId: string;
    diagnostics: RetrievalDiagnostics | null;
    capabilities?: Record<string, unknown>;
  },
  options?: {
    onComplete?: (fullText: string) => {
      type?: "done";
      referencedCitationIds: string[];
      finishReason?: string;
    };
    onFinally?: () => void;
  },
): ReadableStream<Uint8Array> {
  return wrapModelStreamAsOrynodeSse(
    openAiChatStreamToModelEvents(upstream),
    {
      version: ORYNODE_SSE_VERSION,
      traceId: metadata.retrievalTraceId,
      providedCitations: metadata.providedCitations,
      diagnostics: metadata.diagnostics,
      capabilities: metadata.capabilities,
    },
    {
      onComplete: options?.onComplete
        ? (fullText) => {
            const done = options.onComplete!(fullText);
            return {
              referencedCitationIds: done.referencedCitationIds,
              finishReason: done.finishReason,
            };
          }
        : undefined,
      onFinally: options?.onFinally,
    },
  );
}
