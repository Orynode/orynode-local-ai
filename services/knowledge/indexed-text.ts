/**
 * IndexedText 坐标系 — citation 行号 / 文本预览的唯一契约。
 *
 * | kind        | IndexedText 来源                         | 行号高亮 |
 * |-------------|------------------------------------------|----------|
 * | txt / md    | 原件 `stored_path`                       | ✅       |
 * | office      | `preview_path`（convert 写入的 canonical） | ✅       |
 * | pdf         | 不适用（page / offset / bbox）            | —        |
 *
 * 硬禁止：把 chunks 加上「第 N 段」等装饰后再按全文 startLine 高亮。
 * UI chrome 不得进入 IndexedText 字节流。
 */

export type IndexedTextKind = "original" | "preview_artifact" | "unsupported";

export function indexedTextStrategy(
  fileKind: string | null | undefined,
): IndexedTextKind {
  if (fileKind === "txt" || fileKind === "md") return "original";
  if (fileKind === "office") return "preview_artifact";
  return "unsupported";
}

/** 相对 `.orynode` 数据根的预览 artifact 文件名约定（无目录分隔） */
export function previewArtifactFileName(documentId: string): string {
  const safe = String(documentId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe || "unknown"}.md`;
}
