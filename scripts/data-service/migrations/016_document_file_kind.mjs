/**
 * Migration 016: 文档 file_kind（pdf/txt/md/office）
 *
 * 原件路径可保留真实扩展名；file_kind 显式记录摄取分流。
 * 扩展名列表与 services/knowledge/format-registry.mjs 应对齐；
 * 本迁移为历史回填快照，新增格式请另开迁移，勿改已应用的 CASE。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "016_document_file_kind";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  for (const table of ["knowledge_documents", "conversation_files"]) {
    if (!tableExists(database, table)) continue;
    ensureColumn(database, table, "file_kind", "TEXT");
  }

  // 按 stored_path 扩展名回填；未知则 txt（历史无扩展名文本）
  for (const table of ["knowledge_documents", "conversation_files"]) {
    if (!tableExists(database, table)) continue;
    database.exec(`
      UPDATE ${table}
      SET file_kind = CASE
        WHEN lower(stored_path) LIKE '%.pdf' THEN 'pdf'
        WHEN lower(stored_path) LIKE '%.md' THEN 'md'
        WHEN lower(stored_path) LIKE '%.markdown' THEN 'md'
        WHEN lower(stored_path) LIKE '%.docx'
          OR lower(stored_path) LIKE '%.doc'
          OR lower(stored_path) LIKE '%.pptx'
          OR lower(stored_path) LIKE '%.ppt'
          OR lower(stored_path) LIKE '%.xlsx'
          OR lower(stored_path) LIKE '%.xls'
          OR lower(stored_path) LIKE '%.odt'
          OR lower(stored_path) LIKE '%.ods'
          OR lower(stored_path) LIKE '%.odp'
          OR lower(stored_path) LIKE '%.rtf'
          OR lower(stored_path) LIKE '%.csv'
          THEN 'office'
        WHEN lower(stored_path) LIKE '%.txt' THEN 'txt'
        ELSE COALESCE(file_kind, 'txt')
      END
      WHERE file_kind IS NULL OR file_kind = ''
    `);
  }
}
