/**
 * 013_fts_v2_multilingual — 多字段 FTS v2（ML-005）
 *
 * Expand：新增 knowledge_chunks_fts_v2 / conversation_file_chunks_fts_v2；
 * 回填现有 chunk；legacy FTS v1 表保留服务。
 * index_builds 扩展 analyzer_version / normalizer_version（若列不存在）。
 */

import {
  ANALYZER_VERSION,
  buildMultilingualFields,
  KEYWORD_V2_BUILD_ID,
  NORMALIZER_VERSION,
} from "../multilingual-normalizer.mjs";
import { ensureColumn, tableExists } from "./runner.mjs";

export const id = "013_fts_v2_multilingual";

export { KEYWORD_V2_BUILD_ID, ANALYZER_VERSION, NORMALIZER_VERSION };

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function up(database) {
  const fts5Ready = (() => {
    try {
      const row = database
        .prepare(
          `SELECT value FROM knowledge_engine_capabilities WHERE key = 'fts5'`,
        )
        .get();
      return row?.value === "ready";
    } catch {
      return false;
    }
  })();

  if (!fts5Ready) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_engine_capabilities (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("fts5_v2", "unavailable");
    return;
  }

  try {
    database.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS __orynode_fts5_v2_probe USING fts5(x)`,
    );
    database.exec(`DROP TABLE IF EXISTS __orynode_fts5_v2_probe`);
  } catch (error) {
    console.warn(
      `FTS5 v2 探测失败，跳过: ${error instanceof Error ? error.message : error}`,
    );
    database
      .prepare(
        `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("fts5_v2", "unavailable");
    return;
  }

  if (tableExists(database, "index_builds")) {
    ensureColumn(database, "index_builds", "analyzer_version", "TEXT");
    ensureColumn(database, "index_builds", "normalizer_version", "TEXT");
  }

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts_v2 USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      index_build_id UNINDEXED,
      exact_text,
      zh_text,
      en_text,
      mixed_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_file_chunks_fts_v2 USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      index_build_id UNINDEXED,
      exact_text,
      zh_text,
      en_text,
      mixed_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  backfillFtsV2(database, "library");
  backfillFtsV2(database, "conversation");

  database
    .prepare(
      `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("fts5_v2", "ready");

  database
    .prepare(
      `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("keyword_analyzer_version", ANALYZER_VERSION);

  database
    .prepare(
      `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("keyword_normalizer_version", NORMALIZER_VERSION);
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {"library" | "conversation"} namespace
 */
function backfillFtsV2(database, namespace) {
  const ftsTable =
    namespace === "conversation"
      ? "conversation_file_chunks_fts_v2"
      : "knowledge_chunks_fts_v2";
  const chunkTable =
    namespace === "conversation"
      ? "conversation_file_chunks"
      : "knowledge_chunks";
  const docCol = namespace === "conversation" ? "file_id" : "document_id";

  if (!tableExists(database, chunkTable)) return;

  database.exec(`DELETE FROM ${ftsTable}`);
  const rows = database
    .prepare(
      `SELECT id AS chunkId, ${docCol} AS documentId, content FROM ${chunkTable}`,
    )
    .all();
  const insert = database.prepare(`
    INSERT INTO ${ftsTable} (
      chunk_id, document_id, index_build_id,
      exact_text, zh_text, en_text, mixed_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const fields = buildMultilingualFields(row.content ?? "");
    insert.run(
      row.chunkId,
      row.documentId,
      KEYWORD_V2_BUILD_ID,
      fields.exactText,
      fields.zhText,
      fields.enText,
      fields.mixedText,
    );
  }
}
