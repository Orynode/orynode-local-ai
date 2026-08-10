/**
 * 文档索引状态文案与可用性判定（无 Node 依赖，可供客户端组件使用）
 */

import type {
  KnowledgeDocument,
  KnowledgeDocumentStatus,
} from "../types";
import {
  isOfficeSectionsTruncated,
  officeSectionsTruncatedDetail,
} from "./office-contract";

/** 与 FTS / data-service 白名单一致；改这里必须同步 scripts/data-service/searchable-document-statuses.mjs */
export const SEARCHABLE_DOCUMENT_STATUSES = [
  "ready",
  "embedding",
  "indexed",
  "error",
] as const;

/** 摄取/索引尚未到终态（不含 ready；语义开启时 ready 另判） */
export const IN_FLIGHT_DOCUMENT_STATUSES = [
  "awaiting_chunks",
  "stored",
  "processing",
  "embedding",
] as const;

export type SearchableDocumentStatus =
  (typeof SEARCHABLE_DOCUMENT_STATUSES)[number];

/**
 * 资料库 / 会话附件列表是否应继续轮询。
 * 语义开启时 `ready` 表示关键词已好、向量仍在路上（Job 成功 ≠ 文档终态）。
 */
export function isKnowledgeIndexPending(
  status: string | null | undefined,
  options?: { semanticEnabled?: boolean },
): boolean {
  const value = status ?? "";
  if (
    (IN_FLIGHT_DOCUMENT_STATUSES as readonly string[]).includes(value)
  ) {
    return true;
  }
  if (options?.semanticEnabled && value === "ready") return true;
  return false;
}

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

/** OCR / Office 内容截断：成功可检索但 fitness=degraded */
function isContentTruncated(errorCode: string | null | undefined): boolean {
  return (
    includesCode(errorCode, "OCR_PAGE_TRUNCATED") ||
    isOfficeSectionsTruncated(errorCode)
  );
}

function contentTruncationDetail(
  errorCode: string | null | undefined,
): string {
  if (isOfficeSectionsTruncated(errorCode)) {
    return officeSectionsTruncatedDetail(errorCode);
  }
  return truncatedOcrDetail(errorCode);
}

/**
 * 将持久层状态投影为用户关心的三条轴：
 * 内容是否可检索、语义索引是否可用、失败是否值得重试。
 * UI 不应直接从原始 status 推导动作；可用性必须与 FTS 白名单一致。
 */
export function documentViewStatus(
  document: Pick<
    KnowledgeDocument,
    "status" | "chunkCount" | "errorMessage" | "fileKind"
  >,
  semanticEnabled: boolean,
): KnowledgeDocumentViewStatus {
  const status = document.status ?? "ready";
  const hasChunks = (document.chunkCount ?? 0) > 0;
  const errorCode = document.errorMessage;
  const fileKind = document.fileKind;

  if (status === "processing_error") {
    const pageLimit = includesCode(errorCode, "OCR_PAGE_LIMIT_EXCEEDED");
    const noText = includesCode(errorCode, "OCR_NO_TEXT");
    const disabled = includesCode(errorCode, "OCR_DISABLED");
    const officeEncrypted = includesCode(errorCode, "OFFICE_ENCRYPTED");
    const officeUnsupported = includesCode(errorCode, "OFFICE_UNSUPPORTED");
    const unsuitable =
      pageLimit ||
      noText ||
      disabled ||
      officeEncrypted ||
      officeUnsupported;
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
      label: hasChunks
        ? "正在更新，暂不可检索"
        : statusLabel(status, fileKind),
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
      fitness: isContentTruncated(errorCode) ? "degraded" : "ok",
      severity: isContentTruncated(errorCode) ? "warning" : "neutral",
      label: semanticEnabled ? "关键词 + 语义已就绪" : "可关键词检索",
      detail: isContentTruncated(errorCode)
        ? contentTruncationDetail(errorCode)
        : "可用于检索和对话",
      canAttach: true,
      canRetryProcessing: false,
    };
  }

  return {
    content: "usable",
    semantic: semanticEnabled ? "pending" : "off",
    fitness: isContentTruncated(errorCode) ? "degraded" : "ok",
    severity: isContentTruncated(errorCode)
      ? "warning"
      : semanticEnabled
        ? "info"
        : "neutral",
    label: semanticEnabled ? "关键词可用 · 语义索引中" : "可关键词检索",
    detail: isContentTruncated(errorCode)
      ? contentTruncationDetail(errorCode)
      : "可用于检索和对话",
    canAttach: true,
    canRetryProcessing: false,
  };
}

export function statusLabel(
  status: KnowledgeDocumentStatus | undefined,
  fileKind?: string | null,
): string {
  const isOffice = fileKind === "office";
  switch (status) {
    case "awaiting_chunks":
      return "处理中";
    case "stored":
      return "已存原件";
    case "processing":
      return isOffice ? "正在转换" : "正在识别";
    case "processing_error":
      return isOffice ? "转换失败" : "识别失败";
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
  if (code.includes("OFFICE_ENCRYPTED")) {
    return "文件已加密，无法转换";
  }
  if (code.includes("OFFICE_UNSUPPORTED")) {
    return "不支持的 Office 格式";
  }
  if (code.includes("OFFICE_MALFORMED")) {
    return "Office 文件损坏或无法解析";
  }
  if (code.includes("OFFICE_TIMEOUT")) {
    return "转换超时，可重试";
  }
  if (code.includes("OFFICE_OUTPUTTOOLARGE") || code.includes("OFFICE_OUTPUT_TOO_LARGE")) {
    return "转换结果过大";
  }
  if (code.includes("OFFICE_RESOURCELIMIT") || code.includes("OFFICE_RESOURCE_LIMIT")) {
    return "文件超过 Office 转换资源上限";
  }
  if (code.includes("OFFICE_MISSINGPART") || code.includes("OFFICE_MISSING_PART")) {
    return "Office 文件缺少必要组成部分";
  }
  if (code.includes("OFFICE_IO")) {
    return "读取 Office 文件失败";
  }
  if (code.includes("OFFICE_UNAVAILABLE")) {
    return "Office 转换组件不可用";
  }
  if (isOfficeSectionsTruncated(code)) {
    return officeSectionsTruncatedDetail(code);
  }
  if (code.includes("OFFICE_")) {
    return "Office 转换失败，原文件已保留";
  }
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
