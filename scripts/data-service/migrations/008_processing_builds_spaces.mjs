/**
 * 008_processing_builds_spaces — ProcessingBuild / Space / Binding / sync generation / staging
 *
 * expand：只新增表与可空列；不破坏现有读写。
 */

import { ensureColumn } from "./runner.mjs";

export const id = "008_processing_builds_spaces";

export const LEGACY_PARSER_NAME = "orynode-parser";
export const LEGACY_PARSER_VERSION = "v1";
export const LEGACY_NORMALIZER_VERSION = "plain-v1";

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS processing_builds (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      parser_name TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      ocr_engine TEXT,
      ocr_version TEXT,
      normalizer_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'ready', 'failed', 'superseded')
      ),
      is_active INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      FOREIGN KEY (revision_id) REFERENCES document_revisions(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_processing_builds_revision
      ON processing_builds(revision_id, is_active, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_spaces (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('library', 'conversation', 'agent')),
      owner_ref TEXT,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('persistent', 'scoped')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_spaces_kind
      ON knowledge_spaces(kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS space_document_bindings (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      active_revision_id TEXT,
      active_processing_build_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'tombstoned')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, document_id),
      FOREIGN KEY (space_id) REFERENCES knowledge_spaces(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_space_bindings_space
      ON space_document_bindings(space_id, status);

    CREATE TABLE IF NOT EXISTS storage_staging (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL CHECK (namespace IN ('library', 'conversation')),
      document_id TEXT,
      staging_path TEXT NOT NULL,
      final_path TEXT NOT NULL,
      content_hash TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('writing', 'renamed', 'committed', 'aborted')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_storage_staging_status
      ON storage_staging(status, created_at);
  `);

  ensureColumn(database, "chunk_sets", "processing_build_id", "TEXT");
  ensureColumn(database, "chunk_sets", "is_active", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn(database, "sources", "sync_generation", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(
    database,
    "sources",
    "last_complete_generation",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    database,
    "source_items",
    "last_seen_generation",
    "INTEGER NOT NULL DEFAULT 0",
  );

  // 固定 library space
  const now = new Date().toISOString();
  database
    .prepare(
      `
      INSERT OR IGNORE INTO knowledge_spaces (id, kind, owner_ref, lifecycle, created_at)
      VALUES ('space-library', 'library', 'local-user', 'persistent', ?)
    `,
    )
    .run(now);

  // 为已有 revision 建立 legacy ProcessingBuild，并回填 chunk_sets
  const revisions = database
    .prepare(
      `
      SELECT id AS revisionId, namespace, document_id AS documentId
      FROM document_revisions
    `,
    )
    .all();

  const insertPb = database.prepare(`
    INSERT INTO processing_builds (
      id, revision_id, parser_name, parser_version, ocr_engine, ocr_version,
      normalizer_version, config_hash, status, is_active, error, created_at, activated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'ready', 1, NULL, ?, ?)
  `);
  const findPb = database.prepare(`
    SELECT id FROM processing_builds WHERE revision_id = ? AND is_active = 1 LIMIT 1
  `);
  const linkChunkSet = database.prepare(`
    UPDATE chunk_sets
    SET processing_build_id = ?, is_active = 1
    WHERE revision_id = ?
      AND (processing_build_id IS NULL OR processing_build_id = '')
  `);
  const bindLibrary = database.prepare(`
    INSERT OR IGNORE INTO space_document_bindings (
      id, space_id, document_id, active_revision_id, active_processing_build_id,
      status, created_at, updated_at
    ) VALUES (?, 'space-library', ?, ?, ?, 'active', ?, ?)
  `);

  for (const rev of revisions) {
    let pb = findPb.get(rev.revisionId);
    if (!pb) {
      const pbId = `pb-legacy-${rev.revisionId}`;
      insertPb.run(
        pbId,
        rev.revisionId,
        LEGACY_PARSER_NAME,
        LEGACY_PARSER_VERSION,
        LEGACY_NORMALIZER_VERSION,
        `legacy:${rev.revisionId}`,
        now,
        now,
      );
      pb = { id: pbId };
    }
    linkChunkSet.run(pb.id, rev.revisionId);
    if (rev.namespace === "library") {
      bindLibrary.run(
        `bind-library-${rev.documentId}`,
        rev.documentId,
        rev.revisionId,
        pb.id,
        now,
        now,
      );
    }
  }
}
