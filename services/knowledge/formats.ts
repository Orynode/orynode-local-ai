/**
 * 资料库支持的文件类型（入库前识别）
 *
 * 扩展名 / MIME / kind 的唯一表在 format-registry.mjs；本模块提供类型安全 API
 * 与魔数探测。下游只认 ParsedDocument 文本页；格式差异止步于本模块 + parser /
 * OfficeConverter。
 */

export type {
  KnowledgeFileKind,
  OfficeFormat,
} from "./format-registry.mjs";

export {
  KIND_BY_EXT,
  KIND_BY_MIME,
  OFFICE_EXTS,
  OFFICE_MIME,
  OFFICE_FORMAT_BY_EXT,
  MIME_BY_OFFICE_FORMAT,
  EXT_BY_OFFICE_FORMAT,
  FORMAT_ENTRIES,
  kindFromFileName,
  kindFromMime,
  officeFormatFromFileName,
  resolveKnowledgeFileKind,
  extensionForKind,
  mimeForKind,
  isZipMagic,
  isPdfMagic,
  KNOWLEDGE_FILE_ACCEPT_CORE,
  KNOWLEDGE_FILE_ACCEPT,
} from "./format-registry.mjs";

import type { KnowledgeFileKind } from "./format-registry.mjs";
import {
  KNOWLEDGE_FILE_ACCEPT as ACCEPT_FULL,
  KNOWLEDGE_FILE_ACCEPT_CORE as ACCEPT_CORE,
  isPdfMagic,
  isZipMagic,
  kindFromFileName,
  kindFromMime,
  officeFormatFromFileName,
} from "./format-registry.mjs";

export const KNOWLEDGE_FILE_KIND_LABEL =
  "目前只支持 PDF、TXT、Markdown（.md）与常见 Office（docx/pptx/xlsx、odt/epub/rtf/csv 等）文件";

export const KNOWLEDGE_FILE_KIND_LABEL_NO_OFFICE =
  "目前只支持 PDF、TXT、Markdown（.md）。本机 Office 转换组件不可用，无法导入 docx/pptx/xlsx 等";

/**
 * 按 Office 转换能力生成 accept。
 * 仅 `anydoc` 时暴露 Office；未知 / none 用 CORE（meta 未加载也不误放行）。
 */
export function knowledgeFileAccept(options?: {
  officeConverter?: "anydoc" | "none" | null;
}): string {
  if (options?.officeConverter === "anydoc") {
    return ACCEPT_FULL;
  }
  return ACCEPT_CORE;
}

/** 浏览器 File → 种类（扩展名优先，其次 MIME；无魔数，最终 kind 以服务端为准） */
export function detectBrowserFileKind(file: File): KnowledgeFileKind | null {
  return kindFromFileName(file.name) ?? kindFromMime(file.type);
}

/**
 * 服务端识别：PDF 魔数优先 → 扩展名 / MIME → 文本启发式。
 * txt/md 需为可解码文本（拒绝明显二进制）。
 */
export function detectKnowledgeKind(options: {
  fileName?: string | null;
  contentType?: string | null;
  buffer: ArrayBuffer;
}): KnowledgeFileKind | null {
  const byName = kindFromFileName(options.fileName ?? "");
  const byMime = kindFromMime(options.contentType);
  const bytes = new Uint8Array(options.buffer);

  if (isPdfMagic(bytes)) {
    return "pdf";
  }

  const kind = byName ?? byMime;
  if (kind === "pdf") {
    return null; // 声称 PDF 但魔数不对
  }
  if (kind === "office") {
    const format = officeFormatFromFileName(options.fileName ?? "");
    if (format === "csv" || format === "rtf") {
      return looksLikeText(bytes) ? "office" : null;
    }
    if (isZipMagic(bytes) || byName === "office" || byMime === "office") {
      return "office";
    }
    return null;
  }
  if (kind === "txt" || kind === "md") {
    return looksLikeText(bytes) ? kind : null;
  }
  // 无扩展名时：纯文本可当 txt；ZIP 不当 office（避免误收任意 zip）
  if (looksLikeText(bytes) && !byMime && !byName) {
    return "txt";
  }
  return null;
}

/** PreviewKind 映射：KnowledgeFileKind → 预览层 */
export function previewKindFromKnowledgeKind(
  kind: KnowledgeFileKind | null,
): "pdf" | "text" | "office" | "unknown" {
  if (kind === "pdf") return "pdf";
  if (kind === "office") return "office";
  if (kind === "txt" || kind === "md") return "text";
  return "unknown";
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 32)) weird += 1;
  }
  return weird / sample.length < 0.05;
}
