/**
 * Migration 026: 同一 namespace 下一份源只对应一页。
 *
 * 先清重复行，再把 018 的非唯一 idx_wiki_pages_source 换成 UNIQUE。
 */

import { tableExists } from "./runner.mjs";

export const id = "026_wiki_source_unique";

function deleteFrom(database, table, sql, ...params) {
  if (!tableExists(database, table)) return;
  database.prepare(sql).run(...params);
}

function removeOrphanGraph(database, pageId) {
  deleteFrom(database, "wiki_pages_fts", `DELETE FROM wiki_pages_fts WHERE page_id = ?`, pageId);
  deleteFrom(
    database,
    "wiki_links",
    `DELETE FROM wiki_links WHERE from_id = ? OR to_id = ?`,
    pageId,
    pageId,
  );
  deleteFrom(
    database,
    "wiki_compile_runs",
    `DELETE FROM wiki_compile_runs WHERE page_id = ?`,
    pageId,
  );
  deleteFrom(
    database,
    "wiki_page_revisions",
    `DELETE FROM wiki_page_revisions WHERE page_id = ?`,
    pageId,
  );
  deleteFrom(
    database,
    "wiki_pending_edges",
    `DELETE FROM wiki_pending_edges WHERE from_id = ?`,
    pageId,
  );
  deleteFrom(
    database,
    "wiki_candidates",
    `DELETE FROM wiki_candidates WHERE page_id = ?`,
    pageId,
  );
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  if (!tableExists(database, "wiki_pages")) return;

  const groups = database
    .prepare(
      `
      SELECT namespace, source_document_id AS sourceDocumentId
      FROM wiki_pages
      GROUP BY namespace, source_document_id
      HAVING COUNT(*) > 1
    `,
    )
    .all();

  const listDupes = database.prepare(`
    SELECT id
    FROM wiki_pages
    WHERE namespace = ? AND source_document_id = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const deletePage = database.prepare(`DELETE FROM wiki_pages WHERE id = ?`);

  for (const group of groups) {
    const rows = listDupes.all(group.namespace, group.sourceDocumentId);
    for (const extra of rows.slice(1)) {
      removeOrphanGraph(database, extra.id);
      deletePage.run(extra.id);
    }
  }

  database.exec(`DROP INDEX IF EXISTS idx_wiki_pages_source`);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_pages_source
      ON wiki_pages(namespace, source_document_id)
  `);
}
