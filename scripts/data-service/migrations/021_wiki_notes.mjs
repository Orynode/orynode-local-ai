/**
 * Migration 021: Wiki 对话沉淀笔记
 *
 * 与综述分槽：Chat「沉淀到大纲」追加 notes，不覆盖 synthesis，不锁 user_edited。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "021_wiki_notes";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  ensureColumn(database, "wiki_pages", "notes_markdown", "TEXT");
}
