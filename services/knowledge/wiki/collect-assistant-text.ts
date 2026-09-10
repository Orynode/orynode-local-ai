/**
 * 把 ModelRuntime 的 OpenAI SSE 收成一段助手文本。
 */

import { openAiChatStreamToModelEvents } from "../../chat/model-stream";

export async function collectAssistantText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const events = openAiChatStreamToModelEvents(stream);
  const reader = events.getReader();
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.type === "delta") text += value.text;
      if (value.type === "error") {
        throw new Error(value.message || value.code || "MODEL_STREAM_FAILED");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text.trim();
}
