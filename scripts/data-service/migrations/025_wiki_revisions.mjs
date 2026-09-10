/**
 * Migration 025: Wiki 页版本历史。
 *
 * 综述 / 笔记 / 知识 IR / 人手改变化时落快照，供 diff 与回滚。
 * 大纲-only 变更也会记 reason=outline（便于回滚目录）。publish 不再把大纲误标成 compile。
 */

import { tableExists } from "./runner.mjs";

export const id = "025_wiki_revisions";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_page_revisions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reason TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(page_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_page_revisions_page
      ON wiki_page_revisions(page_id, revision DESC);
  `);
}
