/**
 * 资料库支持的文件类型（入库前识别）
 *
 * 下游只认 ParsedDocument 文本页；格式差异止步于本模块 + parser。
 */

export type KnowledgeFileKind = "pdf" | "txt" | "md";

const KIND_BY_EXT: Record<string, KnowledgeFileKind> = {
  ".pdf": "pdf",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
};

const KIND_BY_MIME: Record<string, KnowledgeFileKind> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

export function extensionForKind(kind: KnowledgeFileKind): string {
  if (kind === "pdf") return "pdf";
  if (kind === "md") return "md";
  return "txt";
}

export function mimeForKind(kind: KnowledgeFileKind): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "md") return "text/markdown";
  return "text/plain";
}

export function kindFromFileName(name: string): KnowledgeFileKind | null {
  const lower = name.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return KIND_BY_EXT[lower.slice(dot)] ?? null;
}

export function kindFromMime(contentType: string | null | undefined): KnowledgeFileKind | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime ? (KIND_BY_MIME[mime] ?? null) : null;
}

/** 浏览器 File → 种类（扩展名优先，其次 MIME） */
export function detectBrowserFileKind(file: File): KnowledgeFileKind | null {
  return kindFromFileName(file.name) ?? kindFromMime(file.type);
}

/**
 * 服务端识别：扩展名 / MIME / PDF 魔数。
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
  if (kind === "txt" || kind === "md") {
    return looksLikeText(bytes) ? kind : null;
  }
  // 无扩展名时：纯文本可当 txt
  if (looksLikeText(bytes) && !byMime && !byName) {
    return "txt";
  }
  return null;
}

export function isPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ); // %PDF-
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    // allow tab/lf/cr and printable + high utf-8 bytes
    if (b < 7 || (b > 14 && b < 32)) weird += 1;
  }
  return weird / sample.length < 0.05;
}
