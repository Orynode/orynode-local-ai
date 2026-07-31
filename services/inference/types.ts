/**
 * 推理服务接口 — 与 app/api/chat、app/api/status 实际调用对齐
 */

import type { ChatMessage } from "../types";

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  top_p: number;
  top_k: number;
  stream: boolean;
  max_completion_tokens?: number;
}

export interface InferenceService {
  chatCompletions(
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<ReadableStream<Uint8Array>>;

  listModels(): Promise<string[]>;
}
