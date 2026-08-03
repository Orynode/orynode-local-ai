/**
 * 001_baseline — 固化当前生产 schema（Phase 0）
 *
 * 不引入目标架构的新表族；仅把现有 CREATE + 列补齐纳入正式迁移。
 */

import { ensureColumn, tableExists } from "./runner.mjs";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      position INTEGER NOT NULL,
      duration_ms INTEGER,
      attachments TEXT,
      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, position);

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      original_name TEXT,
      content_hash TEXT,
      stored_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      page_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      embedding_model TEXT,
      embedding_dim INTEGER,
      error_message TEXT,
      status_updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      position INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (document_id)
        REFERENCES knowledge_documents(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
      ON knowledge_chunks(document_id, page_number, position);

    CREATE TABLE IF NOT EXISTS conversation_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      page_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      embedding_model TEXT,
      embedding_dim INTEGER,
      error_message TEXT,
      status_updated_at TEXT,
      FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      position INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (file_id)
        REFERENCES conversation_files(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation
      ON conversation_files(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation_file_chunks_file
      ON conversation_file_chunks(file_id, page_number, position);
  `);

  // 旧库列对齐（替代静默 catch 的 ALTER TABLE）
  if (tableExists(database, "messages")) {
    ensureColumn(database, "messages", "duration_ms", "INTEGER");
    ensureColumn(database, "messages", "attachments", "TEXT");
  }

  if (tableExists(database, "knowledge_chunks")) {
    ensureColumn(database, "knowledge_chunks", "embedding", "BLOB");
  }

  if (tableExists(database, "knowledge_documents")) {
    ensureColumn(
      database,
      "knowledge_documents",
      "status",
      "TEXT NOT NULL DEFAULT 'ready'",
    );
    ensureColumn(database, "knowledge_documents", "embedding_model", "TEXT");
    ensureColumn(database, "knowledge_documents", "embedding_dim", "INTEGER");
    ensureColumn(database, "knowledge_documents", "error_message", "TEXT");
    ensureColumn(database, "knowledge_documents", "status_updated_at", "TEXT");
    ensureColumn(database, "knowledge_documents", "content_hash", "TEXT");
    ensureColumn(database, "knowledge_documents", "original_name", "TEXT");

    database.exec(`
      UPDATE knowledge_documents
      SET status_updated_at = created_at
      WHERE status_updated_at IS NULL OR status_updated_at = ''
    `);
  }
}

export const id = "001_baseline";
