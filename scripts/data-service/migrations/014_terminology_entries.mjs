/**
 * Migration 014: 可学习术语表（LLM Rewrite 缓存晋升）
 */

export const id = "014_terminology_entries";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS terminology_entries (
      id TEXT PRIMARY KEY,
      domain TEXT,
      terms_json TEXT NOT NULL,
      exclude_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'learned',
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terminology_updated
      ON terminology_entries(updated_at DESC);
  `);
}
