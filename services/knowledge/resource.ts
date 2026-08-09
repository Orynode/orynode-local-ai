/**
 * ResourceCoordinator 客户端（Chat → data-service）
 *
 * active 返回 token；idle 必须带同一 token，避免并发对话互相清掉压力标记。
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../config/defaults";

export async function markChatResourceActive(
  ttlMs = 120_000,
): Promise<string | null> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/resources/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true, ttlMs }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    // 资源协调失败不阻断对话
    return null;
  }
}

export async function markChatResourceIdle(
  token?: string | null,
): Promise<void> {
  // 无 token：未成功 mark active，或协调失败——不得清空全部并发会话
  if (typeof token !== "string" || !token) return;
  try {
    await fetch(`${ORYNODE_DATA_URL}/resources/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false, token }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // ignore
  }
}

/** 查询时探测 Chat 是否占用（失败视为未占用，避免误伤检索） */
export async function isChatResourceActive(): Promise<boolean> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/resources`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { chatActive?: boolean };
    return body.chatActive === true;
  } catch {
    return false;
  }
}

/**
 * 检索与生成的阶段边界：尽力释放查询 embedding，避免低内存设备上
 * e5 与生成模型同时驻留。失败时仍由 markChatResourceActive 的服务端
 * 保护逻辑兜底，不阻断对话。
 */
export async function releaseEmbeddingBeforeGeneration(): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/knowledge/embed/unload`, {
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // 尽力释放；失败不阻断后续生成阶段
  }
}
