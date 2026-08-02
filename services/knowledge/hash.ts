/**
 * 资料库内容身份：字节级 SHA-256（与显示名无关）
 */

import { createHash } from "node:crypto";

export function hashContent(bytes: ArrayBuffer | Uint8Array | Buffer): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : bytes instanceof Buffer
        ? bytes
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return createHash("sha256").update(view).digest("hex");
}

function decodeMaybeUriComponent(value: string): string {
  try {
    // 客户端 header 可能已 encode；避免二次 encode 导致中文显示名变成 %XX
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 资料库去重短路：仅完整可用文档可复用（有分块且非 awaiting_chunks） */
export function isUsableLibraryDocument(doc: {
  status?: string | null;
  chunkCount?: number | null;
}): boolean {
  if (doc.status === "awaiting_chunks") return false;
  return typeof doc.chunkCount === "number" && doc.chunkCount > 0;
}

/** 规范化用户显示名；空则回退到 originalName */
export function resolveDisplayName(
  displayName: string | null | undefined,
  originalName: string,
): string {
  const raw =
    typeof displayName === "string" ? decodeMaybeUriComponent(displayName) : "";
  const trimmed = raw.replace(/[/\\]/g, "_").trim().slice(0, 180);
  return trimmed || originalName.slice(0, 180);
}
