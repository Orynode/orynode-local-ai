/**
 * 002_fts5_keyword_index — SQLite FTS5 关键词索引（Phase 1）
 *
 * 使用独立 FTS 表 + search_text（正文规范化 + 中文 bigram），不改写原始 content。
 */

import { buildSearchText } from "../search-text.mjs";
import { tableExists } from "./runner.mjs";

export const id = "002_fts5_keyword_index";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  // 探测 FTS5：不可用则跳过建表（检索层会降级到全量 keyword）
  try {
    database.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS __orynode_fts5_probe USING fts5(x)`,
    );
    database.exec(`DROP TABLE IF EXISTS __orynode_fts5_probe`);
  } catch (error) {
    const probe = new Error(
      `当前 SQLite 无 FTS5，跳过关键词索引迁移: ${error instanceof Error ? error.message : error}`,
    );
    probe.code = "FTS5_UNAVAILABLE";
    // 仍 stamp 迁移，避免每次启动重试；能力由 runtime 探测
    console.warn(probe.message);
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
      .run("fts5", "unavailable");
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_engine_capabilities (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      search_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_file_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      search_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  database
    .prepare(
      `INSERT INTO knowledge_engine_capabilities (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run("fts5", "ready");

  if (tableExists(database, "knowledge_chunks")) {
    database.exec(`DELETE FROM knowledge_chunks_fts`);
    const rows = database
      .prepare(
        `SELECT id AS chunkId, document_id AS documentId, content FROM knowledge_chunks`,
      )
      .all();
    const insert = database.prepare(
      `INSERT INTO knowledge_chunks_fts (chunk_id, document_id, search_text) VALUES (?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(row.chunkId, row.documentId, buildSearchText(row.content));
    }
  }

  if (tableExists(database, "conversation_file_chunks")) {
    database.exec(`DELETE FROM conversation_file_chunks_fts`);
    const rows = database
      .prepare(
        `SELECT id AS chunkId, file_id AS documentId, content FROM conversation_file_chunks`,
      )
      .all();
    const insert = database.prepare(
      `INSERT INTO conversation_file_chunks_fts (chunk_id, document_id, search_text) VALUES (?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(row.chunkId, row.documentId, buildSearchText(row.content));
    }
  }
}
