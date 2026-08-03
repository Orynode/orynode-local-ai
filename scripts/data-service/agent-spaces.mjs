/**
 * Agent space SQLite 仓储（KE-P3-03）
 */

import { randomUUID } from "node:crypto";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createAgentSpaceStore(database) {
  const getById = database.prepare(`
    SELECT
      id, kind, owner_ref AS ownerRef, lifecycle,
      expires_at AS expiresAt, max_documents AS maxDocuments,
      max_open_chunks AS maxOpenChunks, status,
      created_at AS createdAt, updated_at AS updatedAt
    FROM knowledge_spaces
    WHERE id = ? AND kind = 'agent'
  `);

  const getByOwner = database.prepare(`
    SELECT
      id, kind, owner_ref AS ownerRef, lifecycle,
      expires_at AS expiresAt, max_documents AS maxDocuments,
      max_open_chunks AS maxOpenChunks, status,
      created_at AS createdAt, updated_at AS updatedAt
    FROM knowledge_spaces
    WHERE kind = 'agent' AND owner_ref = ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const insert = database.prepare(`
    INSERT INTO knowledge_spaces (
      id, kind, owner_ref, lifecycle, created_at,
      expires_at, max_documents, max_open_chunks, status, updated_at
    ) VALUES (?, 'agent', ?, 'scoped', ?, ?, ?, ?, 'active', ?)
  `);

  const updateMeta = database.prepare(`
    UPDATE knowledge_spaces
    SET expires_at = ?, max_documents = ?, max_open_chunks = ?,
        status = ?, updated_at = ?
    WHERE id = ?
  `);

  const listBindings = database.prepare(`
    SELECT document_id AS documentId
    FROM space_document_bindings
    WHERE space_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `);

  const upsertBinding = database.prepare(`
    INSERT INTO space_document_bindings (
      id, space_id, document_id, active_revision_id, active_processing_build_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, 'active', ?, ?)
    ON CONFLICT(space_id, document_id) DO UPDATE SET
      status = 'active',
      updated_at = excluded.updated_at
  `);

  const tombstoneExpired = database.prepare(`
    UPDATE knowledge_spaces
    SET status = 'expired', updated_at = ?
    WHERE kind = 'agent'
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < ?
  `);

  function mapSpace(row) {
    if (!row) return null;
    const documentIds = listBindings
      .all(row.id)
      .map((b) => b.documentId)
      .filter(Boolean);
    return {
      id: row.id,
      kind: "agent",
      ownerRef: row.ownerRef,
      lifecycle: "scoped",
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      documentIds,
      maxDocuments: row.maxDocuments ?? 16,
      maxOpenChunks: row.maxOpenChunks ?? 32,
      status: row.status ?? "active",
      updatedAt: row.updatedAt,
    };
  }

  return {
    create({
      ownerRef,
      maxDocuments = 16,
      maxOpenChunks = 32,
      ttlHours = 24,
      id = null,
    }) {
      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(
        now.getTime() + ttlHours * 3600_000,
      ).toISOString();
      const spaceId = id || `agent:${ownerRef}`;
      insert.run(
        spaceId,
        ownerRef,
        createdAt,
        expiresAt,
        maxDocuments,
        maxOpenChunks,
        createdAt,
      );
      return mapSpace(getById.get(spaceId));
    },

    get(id) {
      this.gcExpired();
      const row = getById.get(id);
      if (!row || row.status !== "active") return null;
      if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) {
        updateMeta.run(
          row.expiresAt,
          row.maxDocuments,
          row.maxOpenChunks,
          "expired",
          new Date().toISOString(),
          id,
        );
        return null;
      }
      return mapSpace(row);
    },

    getByOwner(ownerRef) {
      this.gcExpired();
      return mapSpace(getByOwner.get(ownerRef));
    },

    ensure(ownerRef, defaults = {}) {
      const existing = this.getByOwner(ownerRef);
      if (existing) return existing;
      return this.create({ ownerRef, ...defaults });
    },

    bindDocument(spaceId, documentId) {
      const space = this.get(spaceId);
      if (!space) throw new Error("Agent space 不存在或已过期");
      if (space.documentIds.includes(documentId)) return space;
      if (space.documentIds.length >= space.maxDocuments) {
        throw new Error(
          `Agent space 已达文档上限（${space.maxDocuments}）；请缩小范围或新建会话`,
        );
      }
      const now = new Date().toISOString();
      upsertBinding.run(
        randomUUID(),
        spaceId,
        documentId,
        now,
        now,
      );
      return this.get(spaceId);
    },

    gcExpired() {
      const now = new Date().toISOString();
      tombstoneExpired.run(now, now);
    },
  };
}
