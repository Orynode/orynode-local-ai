/**
 * DocumentBlock / chunk_block_refs / processing_build_pages 仓储（KE-030）
 */

import { randomUUID } from "node:crypto";

/**
 * @param {unknown} bbox
 * @returns {string | null}
 */
function serializeBbox(bbox) {
  if (!bbox || typeof bbox !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (bbox);
  const nums = [o.x, o.y, o.width, o.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("OCR_INVALID_BBOX");
  }
  if (
    /** @type {number} */ (o.width) < 0 ||
    /** @type {number} */ (o.height) < 0
  ) {
    throw new Error("OCR_INVALID_BBOX");
  }
  const x = Math.min(1, Math.max(0, /** @type {number} */ (o.x)));
  const y = Math.min(1, Math.max(0, /** @type {number} */ (o.y)));
  const width = Math.min(
    Math.max(0, /** @type {number} */ (o.width)),
    Math.max(0, 1 - x),
  );
  const height = Math.min(
    Math.max(0, /** @type {number} */ (o.height)),
    Math.max(0, 1 - y),
  );
  return JSON.stringify({ x, y, width, height });
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createDocumentBlockStore(database) {
  const insertBlock = database.prepare(`
    INSERT INTO document_blocks (
      id, processing_build_id, page_number, block_type, reading_order,
      text, origin, bbox_json, confidence, language, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteForBuild = database.prepare(`
    DELETE FROM document_blocks WHERE processing_build_id = ?
  `);

  const deleteForPage = database.prepare(`
    DELETE FROM document_blocks
    WHERE processing_build_id = ? AND page_number = ?
  `);

  const listForBuild = database.prepare(`
    SELECT
      id, processing_build_id AS processingBuildId,
      page_number AS pageNumber, block_type AS blockType,
      reading_order AS readingOrder, text, origin,
      bbox_json AS bboxJson, confidence, language,
      created_at AS createdAt
    FROM document_blocks
    WHERE processing_build_id = ?
    ORDER BY page_number ASC, reading_order ASC
  `);

  const insertRef = database.prepare(`
    INSERT INTO chunk_block_refs (
      namespace, chunk_id, block_id, start_offset, end_offset, bbox_degraded
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, chunk_id, block_id) DO UPDATE SET
      start_offset = excluded.start_offset,
      end_offset = excluded.end_offset,
      bbox_degraded = excluded.bbox_degraded
  `);

  const listRefsForChunk = database.prepare(`
    SELECT
      r.namespace, r.chunk_id AS chunkId, r.block_id AS blockId,
      r.start_offset AS startOffset, r.end_offset AS endOffset,
      r.bbox_degraded AS bboxDegraded,
      b.page_number AS pageNumber, b.bbox_json AS bboxJson,
      b.text AS blockText, b.origin
    FROM chunk_block_refs r
    JOIN document_blocks b ON b.id = r.block_id
    WHERE r.namespace = ? AND r.chunk_id = ?
    ORDER BY b.page_number ASC, b.reading_order ASC
  `);

  const upsertPageCheckpoint = database.prepare(`
    INSERT INTO processing_build_pages (
      processing_build_id, page_number, decision, status, completed_at, error_code
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(processing_build_id, page_number) DO UPDATE SET
      decision = excluded.decision,
      status = excluded.status,
      completed_at = excluded.completed_at,
      error_code = excluded.error_code
  `);

  const listCompletedPages = database.prepare(`
    SELECT page_number AS pageNumber
    FROM processing_build_pages
    WHERE processing_build_id = ? AND status = 'completed'
    ORDER BY page_number ASC
  `);

  const deletePagesForBuild = database.prepare(`
    DELETE FROM processing_build_pages WHERE processing_build_id = ?
  `);

  const deleteRefsForChunks = database.prepare(`
    DELETE FROM chunk_block_refs
    WHERE namespace = ? AND chunk_id = ?
  `);

  const upsertLocator = database.prepare(`
    INSERT INTO chunk_locators (
      namespace, chunk_id, page_number, bbox_degraded
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, chunk_id) DO UPDATE SET
      page_number = excluded.page_number,
      bbox_degraded = excluded.bbox_degraded
  `);

  const deleteLocator = database.prepare(`
    DELETE FROM chunk_locators WHERE namespace = ? AND chunk_id = ?
  `);

  const getLocator = database.prepare(`
    SELECT
      namespace, chunk_id AS chunkId, page_number AS pageNumber,
      bbox_degraded AS bboxDegraded
    FROM chunk_locators
    WHERE namespace = ? AND chunk_id = ?
  `);

  return {
    /**
     * @param {string} processingBuildId
     * @param {Array<{
     *   pageNumber: number,
     *   readingOrder: number,
     *   text: string,
     *   origin: 'native_text' | 'ocr',
     *   bbox?: { x: number, y: number, width: number, height: number } | null,
     *   confidence?: number | null,
     *   language?: string | null,
     *   blockType?: string,
     *   id?: string,
     * }>} blocks
     */
    replaceBlocksForBuild(processingBuildId, blocks) {
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteForBuild.run(processingBuildId);
        const ids = [];
        for (const block of blocks) {
          const id = block.id || randomUUID();
          insertBlock.run(
            id,
            processingBuildId,
            block.pageNumber,
            block.blockType || "text",
            block.readingOrder,
            block.text,
            block.origin,
            serializeBbox(block.bbox ?? null),
            block.confidence ?? null,
            block.language ?? null,
            now,
          );
          ids.push(id);
        }
        database.exec("COMMIT");
        return ids;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    /**
     * 按页 checkpoint：替换单页 blocks，保留其他页（Job 续跑）
     */
    upsertPageBlocks(processingBuildId, pageNumber, blocks) {
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteForPage.run(processingBuildId, pageNumber);
        const ids = [];
        for (const block of blocks) {
          const id = block.id || randomUUID();
          insertBlock.run(
            id,
            processingBuildId,
            pageNumber,
            block.blockType || "text",
            block.readingOrder,
            block.text,
            block.origin,
            serializeBbox(block.bbox ?? null),
            block.confidence ?? null,
            block.language ?? null,
            now,
          );
          ids.push(id);
        }
        database.exec("COMMIT");
        return ids;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    /**
     * 显式页级 checkpoint（含 blank / 无文字 OCR 页）
     * @param {string} processingBuildId
     * @param {number} pageNumber
     * @param {{ decision: 'native'|'ocr'|'blank', status?: 'completed'|'failed', errorCode?: string|null }} input
     */
    markPageCheckpoint(processingBuildId, pageNumber, input) {
      const status = input.status === "failed" ? "failed" : "completed";
      const completedAt =
        status === "completed" ? new Date().toISOString() : null;
      upsertPageCheckpoint.run(
        processingBuildId,
        pageNumber,
        input.decision,
        status,
        completedAt,
        input.errorCode ?? null,
      );
    },

    listCheckpointPages(processingBuildId) {
      try {
        return listCompletedPages
          .all(processingBuildId)
          .map((row) => Number(row.pageNumber))
          .filter((n) => Number.isFinite(n));
      } catch {
        // migration 011 未应用时回退：仅有 blocks 的页
        const listPageNumbers = database.prepare(`
          SELECT DISTINCT page_number AS pageNumber
          FROM document_blocks
          WHERE processing_build_id = ?
          ORDER BY page_number ASC
        `);
        return listPageNumbers
          .all(processingBuildId)
          .map((row) => Number(row.pageNumber))
          .filter((n) => Number.isFinite(n));
      }
    },

    listBlocks(processingBuildId) {
      return listForBuild.all(processingBuildId).map((row) => ({
        ...row,
        bbox: row.bboxJson ? JSON.parse(row.bboxJson) : null,
      }));
    },

    clearBuild(processingBuildId) {
      deleteForBuild.run(processingBuildId);
      try {
        deletePagesForBuild.run(processingBuildId);
      } catch {
        // ignore
      }
    },

    /**
     * @param {string} namespace
     * @param {string} chunkId
     * @param {Array<{
     *   blockId: string,
     *   startOffset?: number | null,
     *   endOffset?: number | null,
     *   bboxDegraded?: boolean,
     * }>} refs
     */
    setChunkBlockRefs(namespace, chunkId, refs) {
      for (const ref of refs) {
        insertRef.run(
          namespace,
          chunkId,
          ref.blockId,
          ref.startOffset ?? null,
          ref.endOffset ?? null,
          ref.bboxDegraded ? 1 : 0,
        );
      }
    },

    /**
     * 事务内批量写入 refs（调用方持有 BEGIN）
     * @param {string} namespace
     * @param {Array<{
     *   chunkId: string,
     *   refs: Array<{
     *     blockId: string,
     *     startOffset?: number | null,
     *     endOffset?: number | null,
     *     bboxDegraded?: boolean,
     *   }>
     * }>} chunkRefs
     */
    replaceChunkBlockRefsBatch(namespace, chunkRefs) {
      for (const entry of chunkRefs) {
        deleteRefsForChunks.run(namespace, entry.chunkId);
        for (const ref of entry.refs) {
          insertRef.run(
            namespace,
            entry.chunkId,
            ref.blockId,
            ref.startOffset ?? null,
            ref.endOffset ?? null,
            ref.bboxDegraded ? 1 : 0,
          );
        }
      }
    },

    /**
     * 事务内写入 chunk 级 locator（含无 block refs 的 bboxDegraded）
     * @param {string} namespace
     * @param {Array<{ chunkId: string, pageNumber: number, bboxDegraded?: boolean }>} locators
     */
    replaceChunkLocatorsBatch(namespace, locators) {
      for (const entry of locators) {
        try {
          upsertLocator.run(
            namespace,
            entry.chunkId,
            entry.pageNumber,
            entry.bboxDegraded ? 1 : 0,
          );
        } catch {
          // migration 012 未应用时忽略
        }
      }
    },

    clearChunkLocator(namespace, chunkId) {
      try {
        deleteLocator.run(namespace, chunkId);
      } catch {
        // ignore
      }
    },

    getChunkLocator(namespace, chunkId) {
      try {
        const row = getLocator.get(namespace, chunkId);
        if (!row) return null;
        return { ...row, bboxDegraded: Boolean(row.bboxDegraded) };
      } catch {
        return null;
      }
    },

    listChunkBlockRefs(namespace, chunkId) {
      return listRefsForChunk.all(namespace, chunkId).map((row) => ({
        ...row,
        bboxDegraded: Boolean(row.bboxDegraded),
        bbox: row.bboxJson ? JSON.parse(row.bboxJson) : null,
      }));
    },
  };
}
