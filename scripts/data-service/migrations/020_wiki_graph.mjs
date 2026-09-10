/**
 * Migration 020: Wiki 图（链接 / 反链）、人手改标记、编译批次 wiki_builds。
 *
 * 单次 Job 诊断在 023_wiki_compile_runs。智能仍在 services/knowledge/wiki。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "020_wiki_graph";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (tableExists(database, "wiki_pages")) {
    ensureColumn(database, "wiki_pages", "user_edited", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "wiki_pages", "wiki_build_id", "TEXT");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_links (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, rel)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_links_to
      ON wiki_links(to_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_links_from
      ON wiki_links(from_id);

    CREATE TABLE IF NOT EXISTS wiki_builds (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      compiler TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      link_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_builds_ns
      ON wiki_builds(namespace, created_at DESC);
  `);
}
