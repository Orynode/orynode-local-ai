/**
 * 009_agent_spaces — Agent space 持久化列（KE-P3-03）
 */

import { ensureColumn } from "./runner.mjs";

export const id = "009_agent_spaces";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  ensureColumn(database, "knowledge_spaces", "expires_at", "TEXT");
  ensureColumn(database, "knowledge_spaces", "max_documents", "INTEGER");
  ensureColumn(database, "knowledge_spaces", "max_open_chunks", "INTEGER");
  ensureColumn(
    database,
    "knowledge_spaces",
    "status",
    "TEXT NOT NULL DEFAULT 'active'",
  );
  ensureColumn(database, "knowledge_spaces", "updated_at", "TEXT");
}
