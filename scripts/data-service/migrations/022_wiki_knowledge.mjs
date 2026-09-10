/**
 * Migration 022: LLM Wiki 的可回源知识中间表示。
 *
 * claims / aliases / semantic relations 与展示用 Markdown 分开存，
 * 让检索和后续增量编译消费结构化产物。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "022_wiki_knowledge";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  ensureColumn(database, "wiki_pages", "knowledge_json", "TEXT");
}
