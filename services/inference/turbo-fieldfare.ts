/**
 * TurboFieldfare 推理服务适配器
 * 封装与 TurboFieldfare OpenAI 兼容 API 的通信
 */

import {
  TURBO_FIELDFARE_URL,
  EXPECTED_MODEL_ID,
  HTTP_TIMEOUT,
} from "../../config/defaults";
import type { ChatMessage } from "../types";
import type { InferenceService, ChatCompletionRequest } from "./types";

export class TurboFieldfareService implements InferenceService {
  private readonly baseUrl: string;
  private readonly modelId: string;

  constructor(
    baseUrl = TURBO_FIELDFARE_URL,
    modelId = EXPECTED_MODEL_ID,
  ) {
    this.baseUrl = baseUrl;
    this.modelId = modelId;
  }

  async chatCompletions(
    messages: ChatMessage[],
    options: {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const payload: ChatCompletionRequest = {
      model: this.modelId,
      messages,
      temperature: options.temperature ?? 0.2,
      top_p: options.topP ?? 0.95,
      top_k: options.topK ?? 64,
      stream: true,
    };
    if (options.maxTokens && options.maxTokens > 0) {
      payload.max_completion_tokens = options.maxTokens;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT.chat),
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        result.error?.message || "本地模型返回错误",
      );
    }

    if (!response.body) {
      throw new Error("本地模型没有返回可读取的内容");
    }

    return response.body;
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT.status),
      });
      if (!response.ok) return [];
      const result = await response.json();
      return Array.isArray(result.data)
        ? result.data.map((m: { id?: string }) => m.id ?? "unknown")
        : [];
    } catch {
      return [];
    }
  }
}

export const inferenceService: InferenceService = new TurboFieldfareService();
