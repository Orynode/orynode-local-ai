/**
 * Migration 024: Wiki 成熟度表（决策 / pending 边 / 沉淀候选）。
 * 全部新增表，失败可回滚且不影响 wiki_pages。
 */

import { tableExists } from "./runner.mjs";

export const id = "024_wiki_maturity";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_decisions (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_decisions_created
      ON wiki_decisions(created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_pending_edges (
      from_id TEXT NOT NULL,
      target TEXT NOT NULL,
      rel TEXT NOT NULL,
      citations_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (from_id, target, rel)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_pending_edges_from
      ON wiki_pending_edges(from_id);

    CREATE TABLE IF NOT EXISTS wiki_candidates (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_candidates_page
      ON wiki_candidates(page_id, created_at DESC);
  `);
}
