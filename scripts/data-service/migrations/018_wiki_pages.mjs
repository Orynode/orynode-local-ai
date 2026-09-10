/**
 * Migration 018: Wiki 页面（W0 document_mirror）
 *
 * 智能在 services/knowledge/wiki；本表只存编译结果。
 */

export const id = "018_wiki_pages";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      namespace TEXT NOT NULL,
      source_document_id TEXT NOT NULL,
      markdown TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      compiler TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_source
      ON wiki_pages(namespace, source_document_id);
    -- 026 会把该索引换成 UNIQUE(namespace, source_document_id)
  `);

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
        page_id UNINDEXED,
        search_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  } catch (error) {
    console.warn(
      `跳过 wiki_pages_fts（无 FTS5）: ${error instanceof Error ? error.message : error}`,
    );
  }
}
