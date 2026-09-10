/**
 * Migration 019: Wiki 页可选综述列（synthesis_markdown / synthesis_compiler）。
 *
 * 列可被 upsert 写入；产品上由用户点击 compile_wiki 才填。
 * 大纲 markdown / sections 仍由 W0 抽取；重抽大纲省略综述字段时保留旧值。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "019_wiki_synthesis";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;
  ensureColumn(database, "wiki_pages", "synthesis_markdown", "TEXT");
  ensureColumn(database, "wiki_pages", "synthesis_compiler", "TEXT");
}
