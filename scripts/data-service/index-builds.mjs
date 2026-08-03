/**
 * Revision / ChunkSet / IndexBuild 版本管理（Phase 2）
 */

import { createHash, randomUUID } from "node:crypto";
import {
  COMPAT_BASELINE_ARTIFACT_ID,
  embeddingConfigFingerprint,
  getActiveEmbeddingArtifact,
  isEmbeddingBuildCompatible,
} from "./embed-config.mjs";
import {
  createProcessingBuildStore,
  hashProcessingConfig,
  NORMALIZER_VERSION,
  PARSER_NAME,
  PARSER_VERSION,
} from "./processing-builds.mjs";

export const CHUNK_STRATEGY_VERSION = "text-chunker-v1";

/**
 * @param {string} content
 */
export function hashConfig(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createIndexBuildStore(database) {
  const processingBuilds = createProcessingBuildStore(database);

  const insertRevision = database.prepare(`
    INSERT INTO document_revisions (id, namespace, document_id, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, document_id, content_hash) DO NOTHING
  `);
  const getRevision = database.prepare(`
    SELECT id, namespace, document_id AS documentId, content_hash AS contentHash, created_at AS createdAt
    FROM document_revisions
    WHERE namespace = ? AND document_id = ? AND content_hash = ?
  `);

  const insertChunkSet = database.prepare(`
    INSERT INTO chunk_sets (
      id, revision_id, strategy_version, config_hash, status, created_at,
      processing_build_id, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const deactivateChunkSets = database.prepare(`
    UPDATE chunk_sets
    SET is_active = 0
    WHERE revision_id = ? AND is_active = 1 AND id != ?
  `);

  const insertBuild = database.prepare(`
    INSERT INTO index_builds (
      id, chunk_set_id, namespace, document_id, kind, model, model_revision,
      dimension, config_hash, status, is_active, error, created_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);

  const deactivateActive = database.prepare(`
    UPDATE index_builds
    SET is_active = 0, status = 'superseded'
    WHERE namespace = ? AND document_id = ? AND kind = ? AND is_active = 1
  `);

  const activateBuild = database.prepare(`
    UPDATE index_builds
    SET is_active = 1, status = 'ready', activated_at = ?, error = NULL
    WHERE id = ?
  `);

  const setBuildStatus = database.prepare(`
    UPDATE index_builds
    SET status = ?, error = ?
    WHERE id = ?
  `);

  const getActive = database.prepare(`
    SELECT
      id, chunk_set_id AS chunkSetId, namespace, document_id AS documentId,
      kind, model, model_revision AS modelRevision, dimension, config_hash AS configHash,
      status, is_active AS isActive, error, created_at AS createdAt, activated_at AS activatedAt
    FROM index_builds
    WHERE namespace = ? AND document_id = ? AND kind = ? AND is_active = 1
    LIMIT 1
  `);

  const getBuild = database.prepare(`
    SELECT
      id, chunk_set_id AS chunkSetId, namespace, document_id AS documentId,
      kind, model, model_revision AS modelRevision, dimension, config_hash AS configHash,
      status, is_active AS isActive, error, created_at AS createdAt, activated_at AS activatedAt
    FROM index_builds
    WHERE id = ?
  `);

  return {
    ensureRevision(namespace, documentId, contentHash) {
      const now = new Date().toISOString();
      const hash = contentHash || `unknown:${documentId}`;
      insertRevision.run(randomUUID(), namespace, documentId, hash, now);
      const revision = getRevision.get(namespace, documentId, hash);
      if (!revision) throw new Error("创建 document_revision 失败");
      return revision;
    },

    /**
     * 提交文本 chunks 后：确保 revision + chunk_set + keyword build(active)
     * 默认单事务；inTransaction=true 时由调用方持有 BEGIN/COMMIT。
     * @returns {{ revisionId: string, chunkSetId: string, keywordBuildId: string, vectorBuildId: string | null }}
     */
    recordKeywordReady({
      namespace,
      documentId,
      contentHash,
      strategyVersion = CHUNK_STRATEGY_VERSION,
      chunkConfigHash,
      enqueueVector = false,
      vectorModel = null,
      vectorDim = null,
      /** OCR 路径传入已有 ProcessingBuild，避免双重激活导致 blocks 与 chunk_set 脱节 */
      processingBuildId = null,
      /**
       * false：只挂 chunk_set，不 supersede/激活（须已在外部激活或稍后激活）
       * 缺省 true 保持同步 ingest 兼容
       */
      activateProcessing = true,
      /** 调用方已 BEGIN 时为 true，禁止嵌套事务 */
      inTransaction = false,
      /** 测试用：ProcessingBuild 激活后注入失败，验证同事务回滚 */
      __failAfterProcessingActivate = false,
    }) {
      const run = () => {
        const now = new Date().toISOString();
        const hash = contentHash || `unknown:${documentId}`;
        insertRevision.run(randomUUID(), namespace, documentId, hash, now);
        const revision = getRevision.get(namespace, documentId, hash);
        if (!revision) {
          throw new Error("创建 document_revision 失败");
        }

        let processing = null;
        if (typeof processingBuildId === "string" && processingBuildId) {
          processing = processingBuilds.get(processingBuildId);
          if (!processing) {
            throw new Error("指定的 ProcessingBuild 不存在");
          }
          if (processing.revisionId !== revision.id) {
            throw new Error("ProcessingBuild 与 revision 不匹配");
          }
          if (
            activateProcessing &&
            (!processing.isActive || processing.status !== "ready")
          ) {
            processing =
              processingBuilds.activateReadyInTransaction(processingBuildId);
          }
        } else {
          processing = processingBuilds.createAndActivateInTransaction({
            revisionId: revision.id,
            parserName: PARSER_NAME,
            parserVersion: PARSER_VERSION,
            normalizerVersion: NORMALIZER_VERSION,
            configHash: hashProcessingConfig(
              `${PARSER_NAME}:${PARSER_VERSION}:${strategyVersion}:${hash}`,
            ),
          });
        }

        if (__failAfterProcessingActivate) {
          throw new Error("TEST_FAIL_AFTER_PROCESSING_ACTIVATE");
        }

        const chunkSetId = randomUUID();
        const configHash =
          chunkConfigHash ||
          hashConfig(`${strategyVersion}:${namespace}:${documentId}:${hash}`);
        insertChunkSet.run(
          chunkSetId,
          revision.id,
          strategyVersion,
          configHash,
          "ready",
          now,
          processing.id,
        );
        deactivateChunkSets.run(revision.id, chunkSetId);

        try {
          database
            .prepare(
              `
            INSERT INTO space_document_bindings (
              id, space_id, document_id, active_revision_id, active_processing_build_id,
              status, created_at, updated_at
            ) VALUES (?, 'space-library', ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(space_id, document_id) DO UPDATE SET
              active_revision_id = excluded.active_revision_id,
              active_processing_build_id = excluded.active_processing_build_id,
              status = 'active',
              updated_at = excluded.updated_at
          `,
            )
            .run(
              `bind-library-${documentId}`,
              documentId,
              revision.id,
              processing.id,
              now,
              now,
            );
        } catch {
          // 表尚未迁移时忽略
        }

        const keywordBuildId = randomUUID();
        deactivateActive.run(namespace, documentId, "keyword");
        insertBuild.run(
          keywordBuildId,
          chunkSetId,
          namespace,
          documentId,
          "keyword",
          "fts5-search-text",
          null,
          null,
          configHash,
          "ready",
          1,
          now,
          now,
        );

        let vectorBuildId = null;
        if (enqueueVector) {
          vectorBuildId = randomUUID();
          const artifact = getActiveEmbeddingArtifact();
          const model = vectorModel || artifact.id;
          const dim = vectorDim || artifact.dimension;
          const revision =
            model === artifact.id ? artifact.revision : null;
          const vectorHash = hashConfig(
            `vector:${embeddingConfigFingerprint(artifact)}:${configHash}`,
          );
          insertBuild.run(
            vectorBuildId,
            chunkSetId,
            namespace,
            documentId,
            "vector",
            model,
            revision,
            dim,
            vectorHash,
            "queued",
            0,
            now,
            null,
          );
        }
        return {
          revisionId: revision.id,
          processingBuildId: processing.id,
          chunkSetId,
          keywordBuildId,
          vectorBuildId,
        };
      };

      if (inTransaction) {
        return run();
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    markBuildRunning(buildId) {
      setBuildStatus.run("running", null, buildId);
      return getBuild.get(buildId);
    },

    /**
     * 原子切换：新 build ready+active，旧 active → superseded
     */
    activateBuild(buildId) {
      const build = getBuild.get(buildId);
      if (!build) throw new Error("index_build 不存在");
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        deactivateActive.run(build.namespace, build.documentId, build.kind);
        activateBuild.run(now, buildId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return getBuild.get(buildId);
    },

    markBuildFailed(buildId, error) {
      setBuildStatus.run("failed", String(error).slice(0, 2000), buildId);
      return getBuild.get(buildId);
    },

    /**
     * 为重索引 / 无 buildId 的 Job 创建 queued vector IndexBuild（不触碰旧 active）
     */
    enqueueVectorBuild({
      namespace,
      documentId,
      vectorModel = null,
      vectorDim = null,
    }) {
      const now = new Date().toISOString();
      let chunkSetId = getActive.get(namespace, documentId, "keyword")?.chunkSetId;
      if (!chunkSetId) {
        const contentHash = `reembed:${documentId}:${now}`;
        insertRevision.run(randomUUID(), namespace, documentId, contentHash, now);
        const revision = getRevision.get(namespace, documentId, contentHash);
        if (!revision) throw new Error("创建 revision 失败");
        const processing = processingBuilds.createAndActivate({
          revisionId: revision.id,
        });
        chunkSetId = randomUUID();
        const configHash = hashConfig(`reembed:${namespace}:${documentId}`);
        insertChunkSet.run(
          chunkSetId,
          revision.id,
          CHUNK_STRATEGY_VERSION,
          configHash,
          "ready",
          now,
          processing.id,
        );
      }
      const vectorBuildId = randomUUID();
      const artifact = getActiveEmbeddingArtifact();
      const model = vectorModel || artifact.id;
      const dim = vectorDim || artifact.dimension;
      const revision = model === artifact.id ? artifact.revision : null;
      const configHash = hashConfig(
        `vector:${embeddingConfigFingerprint(artifact)}:${chunkSetId}:${now}`,
      );
      insertBuild.run(
        vectorBuildId,
        chunkSetId,
        namespace,
        documentId,
        "vector",
        model,
        revision,
        dim,
        configHash,
        "queued",
        0,
        now,
        null,
      );
      return vectorBuildId;
    },

    getActiveBuild(namespace, documentId, kind) {
      return getActive.get(namespace, documentId, kind) ?? null;
    },

    /**
     * 资料库文档的 keyword 版本元数据（供 Citation / chunk API）
     * @returns {{ revisionId: string, processingBuildId: string } | null}
     */
    getActiveKeywordVersion(namespace, documentId) {
      const build = getActive.get(namespace, documentId, "keyword");
      if (!build) return null;
      const row = database
        .prepare(
          `
          SELECT
            cs.revision_id AS revisionId,
            COALESCE(cs.processing_build_id, pb.id) AS processingBuildId
          FROM chunk_sets cs
          LEFT JOIN processing_builds pb
            ON pb.revision_id = cs.revision_id AND pb.is_active = 1
          WHERE cs.id = ?
        `,
        )
        .get(build.chunkSetId);
      if (!row?.revisionId) return null;
      return {
        revisionId: row.revisionId,
        // 禁止用 IndexBuild.id 冒充 ProcessingBuild
        processingBuildId: row.processingBuildId || "legacy",
      };
    },

    /**
     * 向量检索用：文档是否允许使用 embedding
     * - active+ready 且与当前 artifact 模型/维度一致 → 允许
     * - 无任何 vector IndexBuild（legacy blob）→ 仅 compat baseline（512）允许
     * - 有 build 但与当前 artifact 不兼容 → 拒绝（禁止改 env 后混用旧向量）
     */
    listLibraryDocumentIdsEligibleForVectorSearch() {
      const artifact = getActiveEmbeddingArtifact();
      const withActive = database
        .prepare(
          `
          SELECT DISTINCT document_id AS documentId, model, dimension
          FROM index_builds
          WHERE namespace = 'library'
            AND kind = 'vector'
            AND is_active = 1
            AND status = 'ready'
        `,
        )
        .all()
        .filter((row) =>
          isEmbeddingBuildCompatible(artifact, {
            model: row.model,
            dimension: row.dimension,
          }),
        )
        .map((row) => row.documentId);
      const withAny = new Set(
        database
          .prepare(
            `
            SELECT DISTINCT document_id AS documentId
            FROM index_builds
            WHERE namespace = 'library' AND kind = 'vector'
          `,
          )
          .all()
          .map((row) => row.documentId),
      );
      return { activeDocumentIds: withActive, documentsWithVectorBuilds: withAny };
    },

    isLibraryDocumentVectorEligible(documentId) {
      const artifact = getActiveEmbeddingArtifact();
      const active = getActive.get("library", documentId, "vector");
      if (active && active.status === "ready") {
        return isEmbeddingBuildCompatible(artifact, {
          model: active.model,
          dimension: active.dimension,
        });
      }
      const any = database
        .prepare(
          `
          SELECT 1 AS ok FROM index_builds
          WHERE namespace = 'library' AND document_id = ? AND kind = 'vector'
          LIMIT 1
        `,
        )
        .get(documentId);
      if (!any) {
        return (
          artifact.id === COMPAT_BASELINE_ARTIFACT_ID ||
          artifact.dimension === 512
        );
      }
      return false;
    },

    getBuild(buildId) {
      return getBuild.get(buildId) ?? null;
    },
  };
}
