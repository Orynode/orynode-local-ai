/**
 * ResourceCoordinator 客户端（Chat → data-service）
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../config/defaults";

export async function markChatResourceActive(ttlMs = 120_000): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/resources/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, ttlMs }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // 资源协调失败不阻断对话
  }
}

export async function markChatResourceIdle(): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/resources/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // ignore
  }
}
