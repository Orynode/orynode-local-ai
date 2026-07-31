/**
 * 文档索引状态文案（无 Node 依赖，可供客户端组件使用）
 */

import type { KnowledgeDocumentStatus } from "../types";

export function statusLabel(
  status: KnowledgeDocumentStatus | undefined,
): string {
  switch (status) {
    case "awaiting_chunks":
      return "处理中";
    case "embedding":
      return "索引中";
    case "indexed":
      return "已索引";
    case "error":
      return "索引失败";
    case "ready":
    default:
      return "关键词";
  }
}
