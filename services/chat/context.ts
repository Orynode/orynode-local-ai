/**
 * 对话上下文预算：按 maxContext 拆分 history / knowledge / output reserve
 */

import type { ChatMessage } from "../types";
import type { ContextBudget } from "../knowledge/core/types";

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
 * 从模型窗口扣除 system 固定开销、输出保留与安全余量后，
 * 拆出独立的 history / knowledge 预算。
 */
export function resolveContextBudget(params: {
  modelContextTokens: number;
  systemBaseTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens?: number;
  /** 剩余额度中知识上下文占比；默认 0.45 */
  knowledgeShare?: number;
}): ContextBudget {
  const modelContextTokens = Math.max(1024, Math.floor(params.modelContextTokens));
  const safetyMarginTokens = Math.max(
    32,
    Math.floor(params.safetyMarginTokens ?? 64),
  );
  const outputReserveTokens = Math.max(
    0,
    Math.floor(params.outputReserveTokens),
  );
  const systemBaseTokens = Math.max(0, Math.floor(params.systemBaseTokens));
  const remaining = Math.max(
    256,
    modelContextTokens - systemBaseTokens - outputReserveTokens - safetyMarginTokens,
  );
  const share = Math.min(0.75, Math.max(0.2, params.knowledgeShare ?? 0.45));
  const knowledgeBudgetTokens = Math.max(128, Math.floor(remaining * share));
  const historyBudgetTokens = Math.max(128, remaining - knowledgeBudgetTokens);

  return {
    modelContextTokens,
    outputReserveTokens,
    historyBudgetTokens,
    knowledgeBudgetTokens,
    safetyMarginTokens,
  };
}

/** 在显式 token 预算内从最新消息往前保留历史 */
export function trimChatHistoryToTokenBudget(
  history: ChatMessage[],
  tokenBudget: number,
): ChatMessage[] {
  const budget = Math.max(32, Math.floor(tokenBudget));
  if (history.length === 0) return [];

  const kept: ChatMessage[] = [];
  let used = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const cost = estimateTokens(message.content) + 4;

    if (kept.length === 0) {
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
