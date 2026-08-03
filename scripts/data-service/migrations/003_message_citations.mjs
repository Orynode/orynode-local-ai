/**
 * 003_message_citations — 消息级引用快照（Phase 1）
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "003_message_citations";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "messages")) return;
  ensureColumn(database, "messages", "citations", "TEXT");
  ensureColumn(database, "messages", "referenced_citation_ids", "TEXT");
  ensureColumn(database, "messages", "retrieval_trace_id", "TEXT");
}
