/**
 * Migration 023: Wiki 编译运行诊断。
 *
 * 记录每次 compile_wiki 的校验尝试、失败码与覆盖率。
 * 本表只存诊断；「失败不得写半成品」由 services/knowledge/wiki 发布门禁保证。
 */

import { tableExists } from "./runner.mjs";

export const id = "023_wiki_compile_runs";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_compile_runs (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      compiler TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      repaired INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      input_hash TEXT,
      section_count INTEGER NOT NULL DEFAULT 0,
      batch_count INTEGER NOT NULL DEFAULT 0,
      claim_count INTEGER NOT NULL DEFAULT 0,
      token_in INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_compile_runs_page
      ON wiki_compile_runs(page_id, created_at DESC);
  `);
}
