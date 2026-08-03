/**
 * Windows ModelRuntime stub — 推理后端未选型前诚实不可用
 */

import type {
  ChatMessage,
  ChatOptions,
  ModelInfo,
  ModelRuntime,
  RuntimeHealth,
} from "../types";

export class ModelCapabilityError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";

  constructor(message = "Windows ModelRuntime 尚未实现") {
    super(message);
    this.name = "ModelCapabilityError";
  }
}

export function createWindowsModelRuntimeStub(): ModelRuntime {
  return {
    async chat(
      _messages: ChatMessage[],
      _options: ChatOptions = {},
    ): Promise<ReadableStream<Uint8Array>> {
      throw new ModelCapabilityError(
        "CAPABILITY_UNAVAILABLE: Windows 本地推理后端尚未选型",
      );
    },

    async listModels(): Promise<ModelInfo[]> {
      return [];
    },

    async health(): Promise<RuntimeHealth> {
      return {
        ok: false,
        detail: "CAPABILITY_UNAVAILABLE",
      };
    },
  };
}
