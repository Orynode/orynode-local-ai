/**
 * ProcessingBuild 仓储（KE-P2-01 + KE-030 OCR 分阶段协议）
 */

import { createHash, randomUUID } from "node:crypto";
import {
  LEGACY_NORMALIZER_VERSION,
  LEGACY_PARSER_NAME,
  LEGACY_PARSER_VERSION,
} from "./migrations/008_processing_builds_spaces.mjs";

export const PARSER_NAME = LEGACY_PARSER_NAME;
export const PARSER_VERSION = LEGACY_PARSER_VERSION;
export const NORMALIZER_VERSION = LEGACY_NORMALIZER_VERSION;

/**
 * @param {string} content
 */
export function hashProcessingConfig(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createProcessingBuildStore(database) {
  const insert = database.prepare(`
    INSERT INTO processing_builds (
      id, revision_id, parser_name, parser_version, ocr_engine, ocr_version,
      normalizer_version, config_hash, status, is_active, error, created_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL)
  `);

  const deactivate = database.prepare(`
    UPDATE processing_builds
    SET is_active = 0, status = 'superseded'
    WHERE revision_id = ? AND is_active = 1
  `);

  const activate = database.prepare(`
    UPDATE processing_builds
    SET is_active = 1, status = 'ready', activated_at = ?, error = NULL
    WHERE id = ?
  `);

  const setStatus = database.prepare(`
    UPDATE processing_builds
    SET status = ?, error = ?
    WHERE id = ?
  `);

  const markFailedStmt = database.prepare(`
    UPDATE processing_builds
    SET status = 'failed', error = ?, is_active = 0
    WHERE id = ?
  `);

  const getById = database.prepare(`
    SELECT
      id, revision_id AS revisionId, parser_name AS parserName,
      parser_version AS parserVersion, ocr_engine AS ocrEngine,
      ocr_version AS ocrVersion, normalizer_version AS normalizerVersion,
      config_hash AS configHash, status, is_active AS isActive, error,
      created_at AS createdAt, activated_at AS activatedAt
    FROM processing_builds
    WHERE id = ?
  `);

  const getActiveForRevision = database.prepare(`
    SELECT
      id, revision_id AS revisionId, parser_name AS parserName,
      parser_version AS parserVersion, ocr_engine AS ocrEngine,
      ocr_version AS ocrVersion, normalizer_version AS normalizerVersion,
      config_hash AS configHash, status, is_active AS isActive, error,
      created_at AS createdAt, activated_at AS activatedAt
    FROM processing_builds
    WHERE revision_id = ? AND is_active = 1
    LIMIT 1
  `);

  return {
    /**
     * 创建 queued build，不影响旧 active（OCR / 异步处理）
     */
    beginBuild({
      revisionId,
      parserName = PARSER_NAME,
      parserVersion = PARSER_VERSION,
      ocrEngine = null,
      ocrVersion = null,
      normalizerVersion = NORMALIZER_VERSION,
      configHash,
      status = "queued",
    }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      const hash =
        configHash ||
        hashProcessingConfig(
          `${parserName}:${parserVersion}:${normalizerVersion}:${ocrEngine}:${ocrVersion}:${revisionId}`,
        );
      insert.run(
        id,
        revisionId,
        parserName,
        parserVersion,
        ocrEngine,
        ocrVersion,
        normalizerVersion,
        hash,
        status,
        now,
      );
      return getById.get(id);
    },

    markRunning(id) {
      setStatus.run("running", null, id);
      return getById.get(id);
    },

    /**
     * 在调用方已持有的事务内激活（禁止嵌套 BEGIN）
     */
    activateReadyInTransaction(id) {
      const row = getById.get(id);
      if (!row) throw new Error("ProcessingBuild 不存在");
      const now = new Date().toISOString();
      deactivate.run(row.revisionId);
      activate.run(now, id);
      return getById.get(id);
    },

    /**
     * 单事务激活：supersede 旧 active
     */
    activateReady(id) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = this.activateReadyInTransaction(id);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    markFailed(id, error) {
      const row = getById.get(id);
      // 已成功激活的 build 不得因后续错误回退（旧 active 已 superseded，回退会丢检索）
      if (row && row.isActive && row.status === "ready") {
        return row;
      }
      markFailedStmt.run(String(error).slice(0, 2000), id);
      return getById.get(id);
    },

    /**
     * 调用方已持有事务时创建并激活
     */
    createAndActivateInTransaction({
      revisionId,
      parserName = PARSER_NAME,
      parserVersion = PARSER_VERSION,
      ocrEngine = null,
      ocrVersion = null,
      normalizerVersion = NORMALIZER_VERSION,
      configHash,
    }) {
      const build = this.beginBuild({
        revisionId,
        parserName,
        parserVersion,
        ocrEngine,
        ocrVersion,
        normalizerVersion,
        configHash,
        status: "ready",
      });
      return this.activateReadyInTransaction(build.id);
    },

    /**
     * 兼容旧路径：创建并立即激活（keyword 同步 ingest）
     */
    createAndActivate({
      revisionId,
      parserName = PARSER_NAME,
      parserVersion = PARSER_VERSION,
      ocrEngine = null,
      ocrVersion = null,
      normalizerVersion = NORMALIZER_VERSION,
      configHash,
    }) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = this.createAndActivateInTransaction({
          revisionId,
          parserName,
          parserVersion,
          ocrEngine,
          ocrVersion,
          normalizerVersion,
          configHash,
        });
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    get(id) {
      return getById.get(id) ?? null;
    },

    getActiveForRevision(revisionId) {
      return getActiveForRevision.get(revisionId) ?? null;
    },
  };
}
