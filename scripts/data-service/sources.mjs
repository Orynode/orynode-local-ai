/**
 * sources / source_items 仓储（data-service）
 */

import { randomUUID } from "node:crypto";
import { createSourceVisibilityStore } from "./source-visibility.mjs";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createSourcesRepository(database) {
  const visibility = createSourceVisibilityStore(database);
  const insertSource = database.prepare(`
    INSERT INTO sources (
      id, type, name, config_json, checkpoint, status,
      last_sync_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'idle', NULL, NULL, ?, ?)
  `);

  const listSources = database.prepare(`
    SELECT
      id, type, name, config_json AS configJson, checkpoint, status,
      last_sync_at AS lastSyncAt, last_error AS lastError,
      created_at AS createdAt, updated_at AS updatedAt
    FROM sources
    ORDER BY updated_at DESC
  `);

  const getSource = database.prepare(`
    SELECT
      id, type, name, config_json AS configJson, checkpoint, status,
      last_sync_at AS lastSyncAt, last_error AS lastError,
      created_at AS createdAt, updated_at AS updatedAt,
      COALESCE(sync_generation, 0) AS syncGeneration,
      COALESCE(last_complete_generation, 0) AS lastCompleteGeneration
    FROM sources
    WHERE id = ?
  `);

  const beginSyncGeneration = database.prepare(`
    UPDATE sources
    SET sync_generation = COALESCE(sync_generation, 0) + 1,
        status = 'syncing',
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
  `);

  const markCompleteGeneration = database.prepare(`
    UPDATE sources
    SET last_complete_generation = sync_generation,
        updated_at = ?
    WHERE id = ?
  `);

  const touchItemGeneration = database.prepare(`
    UPDATE source_items
    SET last_seen_generation = ?, updated_at = ?
    WHERE source_id = ? AND external_id = ?
  `);

  const listStaleForGeneration = database.prepare(`
    SELECT external_id AS externalId
    FROM source_items
    WHERE source_id = ?
      AND tombstone = 0
      AND COALESCE(last_seen_generation, 0) < ?
  `);

  const updateSourceStatus = database.prepare(`
    UPDATE sources
    SET status = ?,
        checkpoint = COALESCE(?, checkpoint),
        last_sync_at = CASE WHEN ? = 1 THEN ? ELSE last_sync_at END,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const deleteSource = database.prepare(`DELETE FROM sources WHERE id = ?`);

  const getItem = database.prepare(`
    SELECT
      id, source_id AS sourceId, external_id AS externalId, uri, title,
      mime_type AS mimeType, content_hash AS contentHash,
      document_id AS documentId, active_revision_id AS activeRevisionId,
      tombstone, metadata_json AS metadataJson, sync_error AS syncError,
      created_at AS createdAt, updated_at AS updatedAt
    FROM source_items
    WHERE source_id = ? AND external_id = ?
  `);

  const listItems = database.prepare(`
    SELECT
      id, source_id AS sourceId, external_id AS externalId, uri, title,
      mime_type AS mimeType, content_hash AS contentHash,
      document_id AS documentId, active_revision_id AS activeRevisionId,
      tombstone, metadata_json AS metadataJson, sync_error AS syncError,
      created_at AS createdAt, updated_at AS updatedAt
    FROM source_items
    WHERE source_id = ?
    ORDER BY updated_at DESC
  `);

  const getByDocument = database.prepare(`
    SELECT
      id, source_id AS sourceId, external_id AS externalId, uri, title,
      mime_type AS mimeType, content_hash AS contentHash,
      document_id AS documentId, active_revision_id AS activeRevisionId,
      tombstone, metadata_json AS metadataJson, sync_error AS syncError,
      created_at AS createdAt, updated_at AS updatedAt
    FROM source_items
    WHERE document_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  const updateItem = database.prepare(`
    UPDATE source_items
    SET uri = ?,
        title = ?,
        mime_type = ?,
        content_hash = ?,
        document_id = ?,
        active_revision_id = ?,
        tombstone = ?,
        metadata_json = ?,
        sync_error = ?,
        last_seen_generation = COALESCE(?, last_seen_generation),
        updated_at = ?
    WHERE source_id = ? AND external_id = ?
  `);

  const insertItem = database.prepare(`
    INSERT INTO source_items (
      id, source_id, external_id, uri, title, mime_type, content_hash,
      document_id, active_revision_id, tombstone, metadata_json,
      sync_error, created_at, updated_at, last_seen_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function mapSource(row) {
    if (!row) return null;
    let config = {};
    try {
      config = JSON.parse(row.configJson || "{}");
    } catch {
      config = {};
    }
    delete config.token;
    delete config.password;
    delete config.secret;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      config,
      checkpoint: row.checkpoint,
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
      syncGeneration: row.syncGeneration ?? 0,
      lastCompleteGeneration: row.lastCompleteGeneration ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function mapItem(row) {
    if (!row) return null;
    let metadata = {};
    try {
      metadata = JSON.parse(row.metadataJson || "{}");
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      sourceId: row.sourceId,
      externalId: row.externalId,
      uri: row.uri,
      title: row.title,
      mimeType: row.mimeType,
      contentHash: row.contentHash,
      documentId: row.documentId,
      activeRevisionId: row.activeRevisionId,
      tombstone: Boolean(row.tombstone),
      metadata,
      syncError: row.syncError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  return {
    create({ type, name, config }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      const safe = { ...(config || {}) };
      delete safe.token;
      delete safe.password;
      delete safe.secret;
      insertSource.run(id, type, name, JSON.stringify(safe), now, now);
      return mapSource(getSource.get(id));
    },

    list() {
      return listSources.all().map(mapSource);
    },

    get(id) {
      return mapSource(getSource.get(id));
    },

    remove(id) {
      return deleteSource.run(id).changes === 1;
    },

    setStatus(id, { status, checkpoint = null, lastError = null }) {
      const now = new Date().toISOString();
      const touchSync = status === "ready" || status === "error" ? 1 : 0;
      updateSourceStatus.run(
        status,
        checkpoint,
        touchSync,
        now,
        lastError,
        now,
        id,
      );
      return mapSource(getSource.get(id));
    },

    /** 开始一次同步 generation；返回新 generation 号 */
    beginSyncGeneration(id) {
      const now = new Date().toISOString();
      beginSyncGeneration.run(now, id);
      return mapSource(getSource.get(id));
    },

    /** 完整可证明枚举完成后推进 last_complete_generation */
    markEnumerationComplete(id) {
      const now = new Date().toISOString();
      markCompleteGeneration.run(now, id);
      return mapSource(getSource.get(id));
    },

    touchItemSeen(sourceId, externalId, generation) {
      const now = new Date().toISOString();
      touchItemGeneration.run(generation, now, sourceId, externalId);
    },

    listStaleExternalIds(sourceId, generation) {
      return listStaleForGeneration
        .all(sourceId, generation)
        .map((row) => row.externalId);
    },

    upsertItem(sourceId, input) {
      const existing = getItem.get(sourceId, input.externalId);
      const now = new Date().toISOString();
      const prevMeta = (() => {
        try {
          return JSON.parse(existing?.metadataJson || "{}");
        } catch {
          return {};
        }
      })();
      const metadata =
        input.metadata !== undefined ? input.metadata : prevMeta;
      const uri = input.uri ?? existing?.uri ?? "";
      const title = input.title ?? existing?.title ?? input.externalId;
      const mimeType =
        input.mimeType !== undefined
          ? input.mimeType
          : (existing?.mimeType ?? null);
      const contentHash =
        input.contentHash !== undefined
          ? input.contentHash
          : (existing?.contentHash ?? null);
      const documentId =
        input.documentId !== undefined
          ? input.documentId
          : (existing?.documentId ?? null);
      const activeRevisionId =
        input.activeRevisionId !== undefined
          ? input.activeRevisionId
          : (existing?.activeRevisionId ?? null);
      const tombstone =
        input.tombstone !== undefined
          ? input.tombstone
            ? 1
            : 0
          : (existing?.tombstone ?? 0);
      const syncError =
        input.syncError !== undefined
          ? input.syncError
          : (existing?.syncError ?? null);

      const previousDocumentId = existing?.documentId ?? null;
      const seenGeneration =
        input.lastSeenGeneration !== undefined
          ? Number(input.lastSeenGeneration)
          : null;

      if (!existing) {
        insertItem.run(
          randomUUID(),
          sourceId,
          input.externalId,
          uri,
          title,
          mimeType,
          contentHash,
          documentId,
          activeRevisionId,
          tombstone,
          JSON.stringify(metadata ?? {}),
          syncError,
          now,
          now,
          seenGeneration ?? 0,
        );
      } else {
        updateItem.run(
          uri,
          title,
          mimeType,
          contentHash,
          documentId,
          activeRevisionId,
          tombstone,
          JSON.stringify(metadata ?? {}),
          syncError,
          seenGeneration,
          now,
          sourceId,
          input.externalId,
        );
      }
      const mapped = mapItem(getItem.get(sourceId, input.externalId));
      visibility.applyItemChange({
        previousDocumentId,
        nextDocumentId: mapped?.documentId ?? documentId,
        tombstone: Boolean(tombstone),
        sourceItemId: mapped?.id ?? null,
      });
      return mapped;
    },

    getItem(sourceId, externalId) {
      return mapItem(getItem.get(sourceId, externalId));
    },

    listItems(sourceId) {
      return listItems.all(sourceId).map(mapItem);
    },

    getByDocument(documentId) {
      return mapItem(getByDocument.get(documentId));
    },
  };
}
