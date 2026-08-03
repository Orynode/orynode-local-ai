/**
 * 007_vector_entries — 版本化向量条目（KE-P0-03）
 *
 * expand：新增 vector_entries；把现有 chunk.embedding 回填到 legacy active IndexBuild。
 * 不删除 knowledge_chunks.embedding（contract 延后）。
 */

import { randomUUID } from "node:crypto";
import { hashConfig, CHUNK_STRATEGY_VERSION } from "../index-builds.mjs";

export const id = "007_vector_entries";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {"library" | "conversation"} namespace
 */
function backfillNamespace(database, namespace) {
  const chunkTable =
    namespace === "library" ? "knowledge_chunks" : "conversation_file_chunks";
  const docIdCol = namespace === "library" ? "document_id" : "file_id";

  const docs = database
    .prepare(
      `
      SELECT DISTINCT ${docIdCol} AS documentId
      FROM ${chunkTable}
      WHERE embedding IS NOT NULL
    `,
    )
    .all();

  const getActive = database.prepare(`
    SELECT id, chunk_set_id AS chunkSetId
    FROM index_builds
    WHERE namespace = ? AND document_id = ? AND kind = 'vector' AND is_active = 1
    LIMIT 1
  `);

  const insertRevision = database.prepare(`
    INSERT INTO document_revisions (id, namespace, document_id, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, document_id, content_hash) DO NOTHING
  `);
  const getRevision = database.prepare(`
    SELECT id FROM document_revisions
    WHERE namespace = ? AND document_id = ? AND content_hash = ?
  `);
  const insertChunkSet = database.prepare(`
    INSERT INTO chunk_sets (id, revision_id, strategy_version, config_hash, status, created_at)
    VALUES (?, ?, ?, ?, 'ready', ?)
  `);
  const insertBuild = database.prepare(`
    INSERT INTO index_builds (
      id, chunk_set_id, namespace, document_id, kind, model, model_revision,
      dimension, config_hash, status, is_active, error, created_at, activated_at
    ) VALUES (?, ?, ?, ?, 'vector', ?, NULL, ?, ?, 'ready', 1, NULL, ?, ?)
  `);
  const insertEntry = database.prepare(`
    INSERT INTO vector_entries (index_build_id, chunk_id, embedding)
    VALUES (?, ?, ?)
    ON CONFLICT(index_build_id, chunk_id) DO UPDATE SET embedding = excluded.embedding
  `);
  const countEntries = database.prepare(`
    SELECT COUNT(*) AS n FROM vector_entries WHERE index_build_id = ?
  `);
  const listEmbeddings = database.prepare(`
    SELECT id AS chunkId, embedding
    FROM ${chunkTable}
    WHERE ${docIdCol} = ? AND embedding IS NOT NULL
  `);

  const now = new Date().toISOString();

  for (const row of docs) {
    const documentId = row.documentId;
    let build = getActive.get(namespace, documentId);
    const embeddings = listEmbeddings.all(documentId);
    if (embeddings.length === 0) continue;

    const sample = embeddings[0].embedding;
    const buf = Buffer.isBuffer(sample) ? sample : Buffer.from(sample);
    const dimension = Math.max(1, Math.floor(buf.byteLength / 4));

    if (!build) {
      const contentHash = `legacy-embed:${documentId}`;
      insertRevision.run(randomUUID(), namespace, documentId, contentHash, now);
      const revision = getRevision.get(namespace, documentId, contentHash);
      if (!revision) continue;
      const chunkSetId = randomUUID();
      const configHash = hashConfig(
        `legacy-vector:${namespace}:${documentId}:${dimension}`,
      );
      insertChunkSet.run(
        chunkSetId,
        revision.id,
        CHUNK_STRATEGY_VERSION,
        configHash,
        now,
      );
      const buildId = randomUUID();
      insertBuild.run(
        buildId,
        chunkSetId,
        namespace,
        documentId,
        "legacy-backfill",
        dimension,
        configHash,
        now,
        now,
      );
      build = { id: buildId, chunkSetId };
    }

    const existing = countEntries.get(build.id)?.n ?? 0;
    if (existing > 0) continue;

    for (const emb of embeddings) {
      insertEntry.run(build.id, emb.chunkId, emb.embedding);
    }
  }
}

/** @param {import("node:sqlite").DatabaseSync} database */
export function up(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vector_entries (
      index_build_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (index_build_id, chunk_id),
      FOREIGN KEY (index_build_id) REFERENCES index_builds(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vector_entries_chunk
      ON vector_entries(chunk_id);
  `);

  backfillNamespace(database, "library");
  backfillNamespace(database, "conversation");
}
