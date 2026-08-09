/**
 * Migration 015: 文本 chunk 行号与 Markdown 标题路径
 *
 * 两套 chunk 表保持对称；heading_path 以 JSON 数组存储。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "015_chunk_text_locators";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  for (const table of ["knowledge_chunks", "conversation_file_chunks"]) {
    if (!tableExists(database, table)) continue;
    ensureColumn(database, table, "start_line", "INTEGER");
    ensureColumn(database, table, "end_line", "INTEGER");
    ensureColumn(database, table, "heading_path", "TEXT");
  }
}
