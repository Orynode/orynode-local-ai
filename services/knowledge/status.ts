/**
 * 文档索引状态文案与可用性判定（无 Node 依赖，可供客户端组件使用）
 */

import type {
  KnowledgeDocument,
  KnowledgeDocumentStatus,
} from "../types";

/** 与 FTS / data-service 白名单一致；改这里必须同步 scripts/data-service/searchable-document-statuses.mjs */
export const SEARCHABLE_DOCUMENT_STATUSES = [
  "ready",
  "embedding",
  "indexed",
  "error",
] as const;

export type SearchableDocumentStatus =
  (typeof SEARCHABLE_DOCUMENT_STATUSES)[number];

function isSearchableStatus(
  status: string | null | undefined,
): status is SearchableDocumentStatus {
  return (SEARCHABLE_DOCUMENT_STATUSES as readonly string[]).includes(
    status ?? "",
  );
}

/**
 * 资料库去重短路 / 对话挂载 / UI 可用性的同一判定：
 * 有分块且 status 落在检索白名单。
 */
export function isUsableLibraryDocument(doc: {
  status?: string | null;
  chunkCount?: number | null;
}): boolean {
  if (!isSearchableStatus(doc.status)) return false;
  return typeof doc.chunkCount === "number" && doc.chunkCount > 0;
}

export type KnowledgeDocumentViewStatus = {
  content: "processing" | "usable" | "unavailable";
  semantic: "off" | "pending" | "ready" | "failed";
  fitness: "ok" | "degraded" | "unsuitable" | "retryable";
  severity: "neutral" | "info" | "warning" | "danger";
  label: string;
  detail: string;
  canAttach: boolean;
  canRetryProcessing: boolean;
};

function includesCode(
  code: string | null | undefined,
  expected: string,
): boolean {
  return Boolean(code?.includes(expected));
}

/**
 * 将持久层状态投影为用户关心的三条轴：
 * 内容是否可检索、语义索引是否可用、失败是否值得重试。
 * UI 不应直接从原始 status 推导动作；可用性必须与 FTS 白名单一致。
 */
export function documentViewStatus(
  document: Pick<
    KnowledgeDocument,
    "status" | "chunkCount" | "errorMessage"
  >,
  semanticEnabled: boolean,
): KnowledgeDocumentViewStatus {
  const status = document.status ?? "ready";
  const hasChunks = (document.chunkCount ?? 0) > 0;
  const errorCode = document.errorMessage;

  if (status === "processing_error") {
    const pageLimit = includesCode(errorCode, "OCR_PAGE_LIMIT_EXCEEDED");
    const noText = includesCode(errorCode, "OCR_NO_TEXT");
    const disabled = includesCode(errorCode, "OCR_DISABLED");
    const unsuitable = pageLimit || noText || disabled;
    const detail = pageLimit
      ? "扫描页超过本机安全上限；请拆分 PDF，或先转为带文字层的 PDF"
      : noText
        ? "未识别出可用文字；请检查原件质量或先在外部完成 OCR"
        : disabled
          ? "已关闭扫描识别；开启 OCR 后再处理，或先转为带文字层的 PDF"
          : processingErrorLabel(errorCode);
    return {
      content: "unavailable",
      semantic: semanticEnabled ? "pending" : "off",
      fitness: unsuitable ? "unsuitable" : "retryable",
      severity: "danger",
      label: hasChunks ? "更新失败，暂不可检索" : "无法建立检索索引",
      detail,
      canAttach: false,
      canRetryProcessing: !unsuitable,
    };
  }

  if (
    status === "awaiting_chunks" ||
    status === "stored" ||
    status === "processing"
  ) {
    return {
      content: "processing",
      semantic: semanticEnabled ? "pending" : "off",
      fitness: "ok",
      severity: "info",
      label: hasChunks ? "正在更新，暂不可检索" : statusLabel(status),
      detail: hasChunks
        ? "更新完成前暂时无法检索和对话，完成后会自动恢复"
        : "原件已保留，完成后才可用于检索和对话",
      canAttach: false,
      canRetryProcessing: false,
    };
  }

  if (!isUsableLibraryDocument(document)) {
    return {
      content: "unavailable",
      semantic: semanticEnabled ? "pending" : "off",
      fitness: "unsuitable",
      severity: "danger",
      label: "未建立检索索引",
      detail: errorCode || "未生成可检索文本，原件仅可预览",
      canAttach: false,
      canRetryProcessing: false,
    };
  }

  if (status === "error") {
    return {
      content: "usable",
      semantic: semanticEnabled ? "failed" : "off",
      fitness: "degraded",
      severity: "warning",
      label: semanticEnabled ? "关键词可用 · 语义索引失败" : "可关键词检索",
      detail: semanticEnabled
        ? "仍可关键词检索；可重建语义索引"
        : "可用于检索和对话",
      canAttach: true,
      canRetryProcessing: false,
    };
  }

  if (status === "indexed") {
    return {
      content: "usable",
      semantic: semanticEnabled ? "ready" : "off",
      fitness: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
        ? "degraded"
        : "ok",
      severity: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
        ? "warning"
        : "neutral",
      label: semanticEnabled ? "关键词 + 语义已就绪" : "可关键词检索",
      detail: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
        ? truncatedOcrDetail(errorCode)
        : "可用于检索和对话",
      canAttach: true,
      canRetryProcessing: false,
    };
  }

  return {
    content: "usable",
    semantic: semanticEnabled ? "pending" : "off",
    fitness: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
      ? "degraded"
      : "ok",
    severity: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
      ? "warning"
      : semanticEnabled
        ? "info"
        : "neutral",
    label: semanticEnabled ? "关键词可用 · 语义索引中" : "可关键词检索",
    detail: includesCode(errorCode, "OCR_PAGE_TRUNCATED")
      ? truncatedOcrDetail(errorCode)
      : "可用于检索和对话",
    canAttach: true,
    canRetryProcessing: false,
  };
}

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
  if (code.includes("OCR_PAGE_TRUNCATED")) {
    return truncatedOcrDetail(code);
  }
  if (code.includes("OCR_HELPER_PROTOCOL_ERROR")) {
    return "OCR 组件协议错误";
  }
  if (code.includes("OCR_NO_TEXT")) {
    return "未能识别出可用文字";
  }
  return code.length > 80 ? `${code.slice(0, 80)}…` : code;
}

/** OCR_PAGE_TRUNCATED:N/M → 用户可读说明 */
function truncatedOcrDetail(code: string | null | undefined): string {
  const raw = String(code ?? "");
  const match = raw.match(/OCR_PAGE_TRUNCATED:(\d+)\/(\d+)/);
  if (match) {
    return `仅识别了前 ${match[1]} 页扫描内容（共 ${match[2]} 页需 OCR），其余页可预览但未入检索`;
  }
  return "仅识别了部分扫描页，其余页可预览但未入检索";
}
