/**
 * Migration 012: chunk 级 locator / bbox_degraded
 *
 * 映射失败时可能没有 block_id，不能仅靠 chunk_block_refs 表达降级。
 */

export const id = "012_chunk_locators";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chunk_locators (
      namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
      chunk_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      bbox_degraded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (namespace, chunk_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_locators_page
      ON chunk_locators(namespace, page_number);
  `);
}
