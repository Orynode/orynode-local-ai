/**
 * macOS ModelRuntime — TurboFieldfare OpenAI 兼容协议适配
 *
 * Chat / Status 只依赖 ModelRuntime port；本文件是唯一允许引用 TurboFieldfare URL 的平台 adapter。
 */

import {
  EXPECTED_MODEL_ID,
  HTTP_TIMEOUT,
  TURBO_FIELDFARE_URL,
} from "../../../config/defaults";
import type {
  ChatMessage,
  ChatOptions,
  ModelInfo,
  ModelRuntime,
  RuntimeHealth,
} from "../types";

export function createTurboFieldfareModelRuntime(
  baseUrl = TURBO_FIELDFARE_URL,
  modelId = EXPECTED_MODEL_ID,
): ModelRuntime {
  return {
    async chat(
      messages: ChatMessage[],
      options: ChatOptions = {},
    ): Promise<ReadableStream<Uint8Array>> {
      const payload: Record<string, unknown> = {
        model: modelId,
        messages,
        temperature: options.temperature ?? 0.2,
        top_p: options.topP ?? 0.95,
        top_k: options.topK ?? 64,
        stream: true,
      };
      if (options.maxTokens && options.maxTokens > 0) {
        payload.max_completion_tokens = options.maxTokens;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT.chat),
      });

      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(result.error?.message || "本地模型返回错误");
      }
      if (!response.body) {
        throw new Error("本地模型没有返回可读取的内容");
      }
      return response.body;
    },

    async listModels(): Promise<ModelInfo[]> {
      try {
        const response = await fetch(`${baseUrl}/models`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT.status),
        });
        if (!response.ok) return [];
        const result = (await response.json()) as {
          data?: Array<{ id?: string }>;
        };
        return Array.isArray(result.data)
          ? result.data.map((m) => ({
              id: m.id ?? "unknown",
              displayName: m.id,
            }))
          : [];
      } catch {
        return [];
      }
    },

    async health(): Promise<RuntimeHealth> {
      try {
        const models = await this.listModels();
        const ok =
          models.some((m) => m.id === modelId) || models.length > 0;
        return {
          ok,
          detail: ok ? `models=${models.length}` : "unreachable",
        };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "unreachable",
        };
      }
    },
  };
}
