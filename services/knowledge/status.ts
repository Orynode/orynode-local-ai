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
    case "stored":
      return "已存原件";
    case "processing":
      return "正在识别";
    case "processing_error":
      return "识别失败";
    case "embedding":
      return "索引中";
    case "indexed":
      return "已索引";
    case "error":
      return "索引失败";
    case "ready":
      return "可关键词检索";
    default:
      return "关键词";
  }
}

/** OCR / 处理失败的稳定错误码 → 用户可读说明 */
export function processingErrorLabel(code: string | null | undefined): string {
  if (!code) return "处理失败，原文件已保留";
  if (code.includes("OCR_UNAVAILABLE")) {
    return "OCR 不可用，原文件已保留";
  }
  if (code.includes("OCR_DISABLED")) {
    return "已关闭扫描识别，原文件已保留";
  }
  if (code.includes("OCR_TIMEOUT")) {
    return "识别超时，可重试";
  }
  if (code.includes("OCR_PAGE_LIMIT_EXCEEDED")) {
    return "扫描页数超过上限";
  }
  if (code.includes("OCR_HELPER_PROTOCOL_ERROR")) {
    return "OCR 组件协议错误";
  }
  if (code.includes("OCR_NO_TEXT")) {
    return "未能识别出可用文字";
  }
  return code.length > 80 ? `${code.slice(0, 80)}…` : code;
}
