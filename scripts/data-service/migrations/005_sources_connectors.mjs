/**
 * 005_sources_connectors — Source / SourceItem（Phase 3）
 */

export const id = "005_sources_connectors";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('file', 'web', 'github')),
      name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      checkpoint TEXT,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sources_type
      ON sources(type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS source_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      title TEXT NOT NULL,
      mime_type TEXT,
      content_hash TEXT,
      document_id TEXT,
      active_revision_id TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      sync_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, external_id),
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_items_source
      ON source_items(source_id, tombstone, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_items_document
      ON source_items(document_id);
  `);
}
