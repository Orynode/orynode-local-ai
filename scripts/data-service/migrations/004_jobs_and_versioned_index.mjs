/**
 * 004_jobs_and_versioned_index — Job 队列 + Revision/ChunkSet/IndexBuild（Phase 2）
 *
 * expand-and-contract：不删除旧 knowledge_* 表；新表并行存在，供后台索引与版本切换。
 */

export const id = "004_jobs_and_versioned_index";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')
      ),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      progress TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(status, available_at, type);
    CREATE INDEX IF NOT EXISTS idx_jobs_updated
      ON jobs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_revisions (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(namespace, document_id, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_document_revisions_doc
      ON document_revisions(namespace, document_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS chunk_sets (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'ready', 'failed')
      ),
      created_at TEXT NOT NULL,
      FOREIGN KEY (revision_id) REFERENCES document_revisions(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunk_sets_revision
      ON chunk_sets(revision_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS index_builds (
      id TEXT PRIMARY KEY,
      chunk_set_id TEXT NOT NULL,
      namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
      document_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('keyword', 'vector')),
      model TEXT,
      model_revision TEXT,
      dimension INTEGER,
      config_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'ready', 'failed', 'superseded')
      ),
      is_active INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      FOREIGN KEY (chunk_set_id) REFERENCES chunk_sets(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_index_builds_doc_kind
      ON index_builds(namespace, document_id, kind, is_active);
    CREATE INDEX IF NOT EXISTS idx_index_builds_chunk_set
      ON index_builds(chunk_set_id, kind, status);
  `);
}
