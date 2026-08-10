/**
 * Migration 017: IndexedText 预览路径（Office canonical markdown）
 *
 * txt/md 的行号坐标系=原件；office 的行号坐标系=convert 写入的 preview 文本。
 * 见 services/knowledge/indexed-text.ts。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "017_preview_path";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  for (const table of ["knowledge_documents", "conversation_files"]) {
    if (!tableExists(database, table)) continue;
    ensureColumn(database, table, "preview_path", "TEXT");
  }
}
