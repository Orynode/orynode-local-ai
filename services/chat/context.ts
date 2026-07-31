/**
 * 对话上下文预算：按 maxContext 裁剪历史，给 system / 回复留空间
 */

import type { ChatMessage } from "../types";

/** 中英混合粗估：约 2 字符 ≈ 1 token（偏保守，少超窗） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 2));
}

function truncateToBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  const maxChars = Math.max(1, tokenBudget * 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 从最新消息往前保留，直到预算用尽。
 * system 与 reserveReply 不占用返回的 history 额度。
 */
export function trimChatHistory(
  systemContent: string,
  history: ChatMessage[],
  maxContext: number,
  options: { maxTokens?: number } = {},
): ChatMessage[] {
  const contextLimit = Math.max(1024, Math.floor(maxContext));
  const replyReserve =
    options.maxTokens && options.maxTokens > 0
      ? Math.min(options.maxTokens, Math.floor(contextLimit * 0.4))
      : Math.max(512, Math.floor(contextLimit * 0.15));

  const systemCost = estimateTokens(systemContent) + 8;
  let budget = contextLimit - systemCost - replyReserve;
  if (budget < 256) budget = 256;

  if (history.length === 0) return [];

  const kept: ChatMessage[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const cost = estimateTokens(message.content) + 4;

    if (kept.length === 0) {
      // 至少保留最新一条；超预算则截断内容
      if (cost > budget) {
        kept.unshift({
          ...message,
          content: truncateToBudget(message.content, Math.max(32, budget - 4)),
        });
      } else {
        kept.unshift(message);
        used = cost;
      }
      continue;
    }

    if (used + cost > budget) break;
    kept.unshift(message);
    used += cost;
  }

  return kept;
}
