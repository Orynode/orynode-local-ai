import { createServer } from "node:http";
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  readSync,
  openSync,
  closeSync,
  statSync,
  createReadStream,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { migrateDatabase } from "./data-service/migrations/index.mjs";
import {
  deleteFtsForDocument,
  searchKeywordIndex,
  upsertFtsChunks,
} from "./data-service/fts-index.mjs";
import { createJobRepository } from "./data-service/jobs.mjs";
import {
  CHUNK_STRATEGY_VERSION,
  createIndexBuildStore,
} from "./data-service/index-builds.mjs";
import { createResourceCoordinator } from "./data-service/resource-coordinator.mjs";
import { startIndexWorker } from "./data-service/worker.mjs";
import { createSourcesRepository } from "./data-service/sources.mjs";
import { createVectorEntryStore } from "./data-service/vector-entries.mjs";
import { createStorageStagingStore } from "./data-service/storage-staging.mjs";
import { createAgentSpaceStore } from "./data-service/agent-spaces.mjs";
import { createLanAuthStore } from "./data-service/lan-auth-store.mjs";
import { createProcessingBuildStore } from "./data-service/processing-builds.mjs";
import { createDocumentBlockStore } from "./data-service/document-blocks.mjs";
import {
  EMBEDDING_CONFIG,
  applyEmbeddingTemplate,
  embeddingConfigFingerprint,
  getActiveEmbeddingArtifact,
} from "./data-service/embed-config.mjs";
import { exportKnowledgePackage } from "./data-service/export-package.mjs";

// Knowledge parsing/chunking/retrieval orchestration live in services/knowledge.
// This process stores files/SQLite/BLOBs. Optional ONNX embedding also runs here
// (real Node), because vinext API Workers cannot load @xenova/transformers.
// Dual namespace: knowledge_documents (library) + conversation_files (chat attachments).
// Web/GitHub connectors (jsdom/octokit) also run here — Workers cannot require() CJS.

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const databasePath =
  process.env.ORYNODE_DATABASE_PATH ??
  resolve(projectRoot, ".orynode/data/orynode.db");
const knowledgeFilesPath = resolve(projectRoot, ".orynode/knowledge/files");
const attachmentsRootPath = resolve(projectRoot, ".orynode/attachments");
const settingsPath =
  process.env.ORYNODE_SETTINGS_PATH ??
  resolve(projectRoot, ".orynode/runtime-settings.json");
const turboAppliedPath = resolve(projectRoot, ".orynode/turbo-applied.json");
const runtimeDefaultsPath = resolve(projectRoot, "config/runtime-defaults.json");
const port = Number(process.env.ORYNODE_DATA_PORT ?? 4318);
const host = "127.0.0.1";

function isLoopbackAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}

/** 原件字节仅允许本机回环访问（defense-in-depth；服务本身已 bind 127.0.0.1） */
function rejectNonLoopbackBytes(request, response) {
  const addr = request.socket?.remoteAddress;
  if (isLoopbackAddress(addr)) return false;
  json(response, 403, { error: "仅本机可访问原件", code: "loopback_only" });
  return true;
}
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);

/** 本机浏览器任意端口（vinext 可能不用 3000） */
function isLoopbackOrigin(origin) {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function loadRuntimeDefaults() {
  try {
    return JSON.parse(readFileSync(runtimeDefaultsPath, "utf8"));
  } catch {
    return {
      temperature: 0.2,
      topP: 0.95,
      topK: 64,
      maxContext: 16384,
      maxTokens: 0,
      allowedMaxContext: [4096, 8192, 16384, 32768, 65536],
    };
  }
}

const runtimeDefaults = loadRuntimeDefaults();
const DEFAULT_RUNTIME_SETTINGS = {
  temperature: runtimeDefaults.temperature,
  topP: runtimeDefaults.topP,
  topK: runtimeDefaults.topK,
  maxContext: runtimeDefaults.maxContext,
  maxTokens: runtimeDefaults.maxTokens,
  knowledgeTier: runtimeDefaults.knowledgeTier === "auto" ||
    runtimeDefaults.knowledgeTier === "balanced" ||
    runtimeDefaults.knowledgeTier === "quality" ||
    runtimeDefaults.knowledgeTier === "lite"
    ? runtimeDefaults.knowledgeTier
    : "auto",
  ocrMode: runtimeDefaults.ocrMode === "disabled" ? "disabled" : "auto",
};
const ALLOWED_MAX_CONTEXT = new Set(runtimeDefaults.allowedMaxContext ?? []);

mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(knowledgeFilesPath, { recursive: true });
mkdirSync(attachmentsRootPath, { recursive: true });
mkdirSync(dirname(settingsPath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA busy_timeout = 5000");
migrateDatabase(database);

const jobRepository = createJobRepository(database);
const indexBuildStore = createIndexBuildStore(database);
const vectorEntryStore = createVectorEntryStore(database);
const resourceCoordinator = createResourceCoordinator();
const sourcesRepository = createSourcesRepository(database);
const agentSpaceStore = createAgentSpaceStore(database);
const lanAuthStore = createLanAuthStore({ projectRoot });
const processingBuildStore = createProcessingBuildStore(database);
const documentBlockStore = createDocumentBlockStore(database);
const storageStaging = createStorageStagingStore(database);
storageStaging.reconcileOnStartup({
  knowledgeFilesPath,
  attachmentFilesPath: attachmentsRootPath,
  log: console,
});

/** Lazy-load TS connectors via tsx (jsdom/octokit stay out of vinext Workers). */
let syncModulePromise = null;
async function loadSyncModule() {
  if (!syncModulePromise) {
    const { register } = await import("tsx/esm/api");
    register();
    syncModulePromise = import(
      pathToFileURL(
        resolve(projectRoot, "services/knowledge/application/sync-source.ts"),
      ).href,
    );
  }
  return syncModulePromise;
}

async function runSyncSourceJob(payload) {
  const sync = await loadSyncModule();
  if (payload?.create?.type === "web") {
    return sync.createAndSyncWebSource(payload.create);
  }
  if (payload?.create?.type === "github") {
    return sync.createAndSyncGitHubSource(payload.create);
  }
  if (typeof payload?.sourceId === "string") {
    return sync.syncSource(payload.sourceId, payload.config);
  }
  throw new Error("sync_source payload 无效");
}

let processRevisionModulePromise = null;
async function loadProcessRevisionModules() {
  if (!processRevisionModulePromise) {
    const { register } = await import("tsx/esm/api");
    register();
    processRevisionModulePromise = Promise.all([
      import(
        pathToFileURL(
          resolve(
            projectRoot,
            "services/knowledge/processing/run-process-revision.ts",
          ),
        ).href,
      ),
      import(
        pathToFileURL(
          resolve(projectRoot, "services/knowledge/processing/analyze-pdf.ts"),
        ).href,
      ),
      import(
        pathToFileURL(
          resolve(
            projectRoot,
            "services/knowledge/processing/page-quality.ts",
          ),
        ).href,
      ),
      import(
        pathToFileURL(
          resolve(projectRoot, "services/knowledge/processing/pdf-render.ts"),
        ).href,
      ),
      import(
        pathToFileURL(resolve(projectRoot, "services/knowledge/chunker.ts"))
          .href,
      ),
      import(
        pathToFileURL(resolve(projectRoot, "services/knowledge/indexer.ts"))
          .href,
      ),
      import(
        pathToFileURL(
          resolve(projectRoot, "services/platform/macos/apple-vision-ocr.ts"),
        ).href,
      ),
      import(
        pathToFileURL(resolve(projectRoot, "services/platform/ocr/fake-ocr.ts"))
          .href,
      ),
    ]);
  }
  return processRevisionModulePromise;
}

function getDocumentMetaForProcess(namespace, documentId) {
  if (namespace === "conversation") {
    const row = getConversationFile.get(documentId);
    return row
      ? { storedPath: row.storedPath, contentHash: row.contentHash }
      : null;
  }
  const row = getKnowledgeDocument.get(documentId);
  return row
    ? { storedPath: row.storedPath, contentHash: row.contentHash }
    : null;
}

/**
 * 入队前 / Worker 启动时确保 ProcessRevisionJobV1 含 revisionId + processingBuildId
 * @param {Record<string, unknown>} payload
 * @param {{ ocrMode?: string, resolveOcrEngine?: () => Promise<any> }} [options]
 */
/**
 * @param {Record<string, unknown>} payload
 * @param {{
 *   ocrMode?: string,
 *   resolveOcrEngine?: () => Promise<any>,
 *   forceNewBuild?: boolean,
 * }} [options]
 */
async function ensureProcessRevisionPayload(payload, options = {}) {
  const namespace =
    payload?.namespace === "conversation" ? "conversation" : "library";
  const documentId = String(payload?.documentId || "");
  if (!documentId) throw new Error("process_revision 缺少 documentId");
  const meta = getDocumentMetaForProcess(namespace, documentId);
  if (!meta) throw new Error("文档不存在");

  const ocrMode =
    payload?.ocrMode === "disabled" || options.ocrMode === "disabled"
      ? "disabled"
      : "auto";

  let revisionId =
    typeof payload?.revisionId === "string" ? payload.revisionId : null;
  let processingBuildId =
    options.forceNewBuild === true
      ? null
      : typeof payload?.processingBuildId === "string"
        ? payload.processingBuildId
        : null;

  if (!revisionId) {
    const revision = indexBuildStore.ensureRevision(
      namespace,
      documentId,
      meta.contentHash,
    );
    revisionId = revision.id;
  }

  // 已激活 ready 的 build 只读；不可续跑/就地修改
  if (processingBuildId) {
    const existing = processingBuildStore.get(processingBuildId);
    if (
      !existing ||
      (existing.isActive && existing.status === "ready")
    ) {
      processingBuildId = null;
    }
  }

  if (!processingBuildId) {
    let ocrEngine = null;
    let ocrVersion = null;
    if (ocrMode !== "disabled" && typeof options.resolveOcrEngine === "function") {
      const engine = await options.resolveOcrEngine();
      const cap = engine ? await engine.capabilities() : null;
      ocrEngine = cap?.engine ?? null;
      ocrVersion = cap?.engineVersion ?? null;
    }
    const build = processingBuildStore.beginBuild({
      revisionId,
      ocrEngine,
      ocrVersion,
      configHash: `ocr:${ocrMode}:accurate:v1`,
    });
    processingBuildId = build.id;
  }

  return {
    version: 1,
    ...payload,
    namespace,
    documentId,
    revisionId,
    processingBuildId,
    ocrMode,
  };
}

/**
 * reprocess / 终端态重入队：failed 未激活可续跑；succeeded 必须新 build
 */
async function prepareReprocessJob(existing, { documentId, ocrMode }) {
  const status = existing.status;
  if (["queued", "running", "retry_wait"].includes(status)) {
    const pbId = existing.payload?.processingBuildId;
    const build = pbId ? processingBuildStore.get(pbId) : null;
    if (build?.isActive && build.status === "ready") {
      const enriched = await ensureProcessRevisionPayload(
        { ...existing.payload, documentId, ocrMode, namespace: "library" },
        { ocrMode, forceNewBuild: true },
      );
      return jobRepository.mergePayload(existing.id, {
        version: 1,
        namespace: "library",
        documentId,
        revisionId: enriched.revisionId,
        processingBuildId: enriched.processingBuildId,
        ocrMode: enriched.ocrMode,
      });
    }
    return existing;
  }

  if (status === "succeeded") {
    const enriched = await ensureProcessRevisionPayload(
      { ...existing.payload, documentId, ocrMode, namespace: "library" },
      { ocrMode, forceNewBuild: true },
    );
    jobRepository.mergePayload(existing.id, {
      version: 1,
      namespace: "library",
      documentId,
      revisionId: enriched.revisionId,
      processingBuildId: enriched.processingBuildId,
      ocrMode: enriched.ocrMode,
    });
    return jobRepository.requeueFromTerminal(existing.id);
  }

  if (status === "failed" || status === "cancelled") {
    const pbId = existing.payload?.processingBuildId;
    const build = pbId ? processingBuildStore.get(pbId) : null;
    const resumable =
      build &&
      !build.isActive &&
      build.status !== "ready" &&
      build.status !== "superseded";
    if (resumable) {
      jobRepository.mergePayload(existing.id, {
        ocrMode,
        namespace: "library",
        documentId,
      });
      return jobRepository.requeueFromTerminal(existing.id);
    }
    const enriched = await ensureProcessRevisionPayload(
      { ...existing.payload, documentId, ocrMode, namespace: "library" },
      { ocrMode, forceNewBuild: true },
    );
    jobRepository.mergePayload(existing.id, {
      version: 1,
      namespace: "library",
      documentId,
      revisionId: enriched.revisionId,
      processingBuildId: enriched.processingBuildId,
      ocrMode: enriched.ocrMode,
    });
    return jobRepository.requeueFromTerminal(existing.id);
  }

  return existing;
}

async function runProcessRevisionJob(payload, hooks = {}) {
  const [
    runMod,
    analyzeMod,
    qualityMod,
    renderMod,
    chunkerMod,
    indexerMod,
    ocrMod,
    fakeOcrMod,
  ] = await loadProcessRevisionModules();

  const settings = readRuntimeSettings();
  const ocrMode =
    payload?.ocrMode === "disabled" || settings.ocrMode === "disabled"
      ? "disabled"
      : "auto";

  const resolveOcrEngine = async () => {
    if (process.env.ORYNODE_OCR_FAKE === "1") {
      return fakeOcrMod.createFakeOcrEngine();
    }
    const engine = ocrMod.createAppleVisionOcrEngine({ projectRoot });
    const cap = await engine.capabilities();
    if (!cap.available) return null;
    return engine;
  };

  let ocrLeaseId = null;
  try {
    const enriched = await ensureProcessRevisionPayload(payload, {
      ocrMode,
      resolveOcrEngine,
    });

    // 写回 Job payload，重试时复用同一 processingBuildId / checkpoint
    if (typeof hooks.jobId === "string" && hooks.jobId) {
      jobRepository.mergePayload(hooks.jobId, {
        version: 1,
        namespace: enriched.namespace,
        documentId: enriched.documentId,
        revisionId: enriched.revisionId,
        processingBuildId: enriched.processingBuildId,
        ocrMode: enriched.ocrMode,
      });
    }

    return await runMod.runProcessRevisionJob({
      payload: enriched,
      ocrMode,
      onProgress: hooks.onProgress,
      heartbeat: () => {
        // worker 侧 interval 已覆盖
      },
      tryAcquireOcr: () => {
        const acquire = resourceCoordinator.tryAcquire({
          kind: "ocr",
          owner: `process-revision:${enriched.documentId || ""}`,
          attemptId: String(enriched.processingBuildId || randomUUID()),
        });
        if (acquire.ok) ocrLeaseId = acquire.leaseId;
        return acquire;
      },
      releaseOcr: (leaseId) => {
        resourceCoordinator.release(leaseId || ocrLeaseId);
        ocrLeaseId = null;
      },
      resolveOcrEngine,
      analyzePdfPages: analyzeMod.analyzePdfPages,
      summarizePageQualities: qualityMod.summarizePageQualities,
      renderPdfPageToPng: renderMod.renderPdfPageToPng,
      cleanupRenderTemp: renderMod.cleanupRenderTemp,
      createChunker: chunkerMod.createChunker,
      assignChunkIds: indexerMod.assignChunkIds,
      commitChunks: async (
        namespace,
        documentId,
        pageCount,
        chunks,
        options = {},
      ) => {
        if (namespace === "conversation") {
          return commitConversationFileChunks(
            documentId,
            pageCount,
            chunks,
            options,
          );
        }
        return commitKnowledgeChunks(documentId, pageCount, chunks, options);
      },
      setDocumentStatus: setDocumentStatusForWorker,
      processingBuilds: processingBuildStore,
      documentBlocks: documentBlockStore,
      getDocumentMeta: getDocumentMetaForProcess,
    });
  } catch (error) {
    if (String(error?.message || "").startsWith("OCR_LEASE_BUSY")) {
      return { deferred: true, reason: "ocr_busy" };
    }
    throw error;
  }
}

async function waitForJob(jobId, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = jobRepository.get(jobId);
    if (!job) throw new Error("任务不存在");
    if (job.status === "succeeded") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error || `任务 ${job.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
  }
  throw new Error("同步任务超时");
}

function semanticSearchEnabled() {
  return (
    process.env.ORYNODE_SEMANTIC_SEARCH === "1" ||
    process.env.ORYNODE_SEMANTIC_SEARCH === "true"
  );
}

/** embedding 状态超过此时长视为中断，自动降为 error 以便 keyword + 可重建 */
const EMBEDDING_STALE_MS = 20 * 60 * 1000;

const listConversations = database.prepare(`
  SELECT
    conversations.id,
    conversations.title,
    conversations.created_at AS createdAt,
    conversations.updated_at AS updatedAt,
    COUNT(messages.id) AS messageCount
  FROM conversations
  LEFT JOIN messages ON messages.conversation_id = conversations.id
  GROUP BY conversations.id
  ORDER BY conversations.updated_at DESC
  LIMIT 100
`);
const getConversation = database.prepare(`
  SELECT
    id,
    title,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM conversations
  WHERE id = ?
`);
const getMessages = database.prepare(`
  SELECT
    id,
    role,
    content,
    created_at AS createdAt,
    duration_ms AS durationMs,
    attachments,
    citations,
    referenced_citation_ids AS referencedCitationIds,
    retrieval_trace_id AS retrievalTraceId
  FROM messages
  WHERE conversation_id = ?
  ORDER BY position ASC
`);
const upsertConversation = database.prepare(`
  INSERT INTO conversations (id, title, created_at, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    updated_at = excluded.updated_at
`);
const deleteMessages = database.prepare(
  "DELETE FROM messages WHERE conversation_id = ?",
);
const insertMessage = database.prepare(`
  INSERT INTO messages (
    id, conversation_id, role, content, created_at, position, duration_ms,
    attachments, citations, referenced_citation_ids, retrieval_trace_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteConversation = database.prepare(
  "DELETE FROM conversations WHERE id = ?",
);
const clearConversations = database.prepare("DELETE FROM conversations");
const listKnowledgeDocuments = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  ORDER BY created_at DESC
`);
const getKnowledgeDocument = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  WHERE id = ?
`);
const getKnowledgeDocumentByHash = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  WHERE content_hash = ?
`);
const insertKnowledgeDocument = database.prepare(`
  INSERT INTO knowledge_documents (
    id, name, original_name, content_hash, stored_path, size, page_count,
    chunk_count, created_at, status, embedding_model, embedding_dim,
    error_message, status_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateKnowledgeDocumentName = database.prepare(`
  UPDATE knowledge_documents SET name = ? WHERE id = ?
`);
const updateKnowledgeDocumentHashMeta = database.prepare(`
  UPDATE knowledge_documents
  SET content_hash = ?, original_name = COALESCE(original_name, ?)
  WHERE id = ?
`);
const insertKnowledgeChunk = database.prepare(`
  INSERT INTO knowledge_chunks (
    id, document_id, page_number, position, content, embedding
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getKnowledgeChunks = database.prepare(`
  SELECT
    id,
    document_id AS documentId,
    page_number AS pageNumber,
    position,
    content
  FROM knowledge_chunks
  WHERE document_id = ?
  ORDER BY page_number, position
`);
const getLibraryChunkById = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_chunks.id = ?
`);
const getConversationChunkById = database.prepare(`
  SELECT
    conversation_file_chunks.id,
    conversation_file_chunks.file_id AS documentId,
    conversation_files.name AS documentName,
    conversation_files.conversation_id AS conversationId,
    conversation_file_chunks.page_number AS pageNumber,
    conversation_file_chunks.position,
    conversation_file_chunks.content
  FROM conversation_file_chunks
  INNER JOIN conversation_files
    ON conversation_files.id = conversation_file_chunks.file_id
  WHERE conversation_file_chunks.id = ?
`);
const listKnowledgeChunksByDocuments = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_chunks.document_id IN (SELECT value FROM json_each(?))
    AND knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
    AND knowledge_chunks.document_id NOT IN (
      SELECT document_id FROM library_search_exclusions
    )
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listAllKnowledgeChunks = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
    AND knowledge_chunks.document_id NOT IN (
      SELECT document_id FROM library_search_exclusions
    )
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listChunksWithVectorsByDocuments = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content,
    COALESCE(vector_entries.embedding, knowledge_chunks.embedding) AS embedding
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  LEFT JOIN index_builds
    ON index_builds.namespace = 'library'
    AND index_builds.document_id = knowledge_chunks.document_id
    AND index_builds.kind = 'vector'
    AND index_builds.is_active = 1
    AND index_builds.status = 'ready'
  LEFT JOIN vector_entries
    ON vector_entries.index_build_id = index_builds.id
    AND vector_entries.chunk_id = knowledge_chunks.id
  WHERE knowledge_chunks.document_id IN (SELECT value FROM json_each(?))
    AND knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
    AND knowledge_chunks.document_id NOT IN (
      SELECT document_id FROM library_search_exclusions
    )
    AND COALESCE(vector_entries.embedding, knowledge_chunks.embedding) IS NOT NULL
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listAllChunksWithVectors = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content,
    COALESCE(vector_entries.embedding, knowledge_chunks.embedding) AS embedding
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  LEFT JOIN index_builds
    ON index_builds.namespace = 'library'
    AND index_builds.document_id = knowledge_chunks.document_id
    AND index_builds.kind = 'vector'
    AND index_builds.is_active = 1
    AND index_builds.status = 'ready'
  LEFT JOIN vector_entries
    ON vector_entries.index_build_id = index_builds.id
    AND vector_entries.chunk_id = knowledge_chunks.id
  WHERE knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
    AND knowledge_chunks.document_id NOT IN (
      SELECT document_id FROM library_search_exclusions
    )
    AND COALESCE(vector_entries.embedding, knowledge_chunks.embedding) IS NOT NULL
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const updateChunkEmbedding = database.prepare(`
  UPDATE knowledge_chunks SET embedding = ? WHERE id = ?
`);
const clearDocumentEmbeddings = database.prepare(`
  UPDATE knowledge_chunks SET embedding = NULL WHERE document_id = ?
`);
const updateDocumentStatus = database.prepare(`
  UPDATE knowledge_documents
  SET
    status = ?,
    embedding_model = ?,
    embedding_dim = ?,
    error_message = ?,
    status_updated_at = ?
  WHERE id = ?
`);
const commitDocumentChunksMeta = database.prepare(`
  UPDATE knowledge_documents
  SET
    page_count = ?,
    chunk_count = ?,
    status = ?,
    error_message = NULL,
    status_updated_at = ?
  WHERE id = ?
`);
const deleteChunksForDocument = database.prepare(
  "DELETE FROM knowledge_chunks WHERE document_id = ?",
);
const deleteKnowledgeDocument = database.prepare(
  "DELETE FROM knowledge_documents WHERE id = ?",
);

const listConversationFilesByConversation = database.prepare(`
  SELECT
    id,
    conversation_id AS conversationId,
    name,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt,
    stored_path AS storedPath
  FROM conversation_files
  WHERE conversation_id = ?
  ORDER BY created_at DESC
`);
const getConversationFile = database.prepare(`
  SELECT
    id,
    conversation_id AS conversationId,
    name,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM conversation_files
  WHERE id = ?
`);
const insertConversationFile = database.prepare(`
  INSERT INTO conversation_files (
    id, conversation_id, name, stored_path, size, page_count, chunk_count,
    created_at, status, embedding_model, embedding_dim, error_message,
    status_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertConversationFileChunk = database.prepare(`
  INSERT INTO conversation_file_chunks (
    id, file_id, page_number, position, content, embedding
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getConversationFileChunks = database.prepare(`
  SELECT
    id,
    file_id AS documentId,
    page_number AS pageNumber,
    position,
    content
  FROM conversation_file_chunks
  WHERE file_id = ?
  ORDER BY page_number, position
`);
const listConversationChunksByFiles = database.prepare(`
  SELECT
    conversation_file_chunks.id,
    conversation_file_chunks.file_id AS documentId,
    conversation_files.name AS documentName,
    conversation_file_chunks.page_number AS pageNumber,
    conversation_file_chunks.position,
    conversation_file_chunks.content
  FROM conversation_file_chunks
  INNER JOIN conversation_files
    ON conversation_files.id = conversation_file_chunks.file_id
  WHERE conversation_file_chunks.file_id IN (SELECT value FROM json_each(?))
    AND conversation_files.conversation_id = ?
    AND conversation_files.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY conversation_files.name, conversation_file_chunks.page_number,
    conversation_file_chunks.position
`);
const listConversationChunksWithVectorsByFiles = database.prepare(`
  SELECT
    conversation_file_chunks.id,
    conversation_file_chunks.file_id AS documentId,
    conversation_files.name AS documentName,
    conversation_file_chunks.page_number AS pageNumber,
    conversation_file_chunks.position,
    conversation_file_chunks.content,
    COALESCE(vector_entries.embedding, conversation_file_chunks.embedding) AS embedding
  FROM conversation_file_chunks
  INNER JOIN conversation_files
    ON conversation_files.id = conversation_file_chunks.file_id
  LEFT JOIN index_builds
    ON index_builds.namespace = 'conversation'
    AND index_builds.document_id = conversation_file_chunks.file_id
    AND index_builds.kind = 'vector'
    AND index_builds.is_active = 1
    AND index_builds.status = 'ready'
  LEFT JOIN vector_entries
    ON vector_entries.index_build_id = index_builds.id
    AND vector_entries.chunk_id = conversation_file_chunks.id
  WHERE conversation_file_chunks.file_id IN (SELECT value FROM json_each(?))
    AND conversation_files.conversation_id = ?
    AND conversation_files.status IN ('ready', 'embedding', 'indexed', 'error')
    AND COALESCE(vector_entries.embedding, conversation_file_chunks.embedding) IS NOT NULL
  ORDER BY conversation_files.name, conversation_file_chunks.page_number,
    conversation_file_chunks.position
`);
const updateConversationChunkEmbedding = database.prepare(`
  UPDATE conversation_file_chunks SET embedding = ? WHERE id = ?
`);
const clearConversationFileEmbeddings = database.prepare(`
  UPDATE conversation_file_chunks SET embedding = NULL WHERE file_id = ?
`);
const updateConversationFileStatus = database.prepare(`
  UPDATE conversation_files
  SET
    status = ?,
    embedding_model = ?,
    embedding_dim = ?,
    error_message = ?,
    status_updated_at = ?
  WHERE id = ?
`);
const commitConversationFileChunksMeta = database.prepare(`
  UPDATE conversation_files
  SET
    page_count = ?,
    chunk_count = ?,
    status = ?,
    error_message = NULL,
    status_updated_at = ?
  WHERE id = ?
`);
const listConversationFilesForStale = database.prepare(`
  SELECT
    id,
    status,
    status_updated_at AS statusUpdatedAt,
    created_at AS createdAt
  FROM conversation_files
`);
const deleteChunksForConversationFile = database.prepare(
  "DELETE FROM conversation_file_chunks WHERE file_id = ?",
);
const deleteConversationFile = database.prepare(
  "DELETE FROM conversation_files WHERE id = ?",
);

function embeddingToArray(embedding) {
  if (!embedding) return null;
  const buf = Buffer.isBuffer(embedding) ? embedding : Buffer.from(embedding);
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  return Array.from(
    new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
  );
}

function arrayToEmbeddingBlob(vector) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function mapDocumentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    originalName: row.originalName ?? row.name,
    contentHash: row.contentHash ?? null,
    size: row.size,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    status: row.status ?? "ready",
    embeddingModel: row.embeddingModel ?? null,
    embeddingDim: row.embeddingDim ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeDisplayName(displayName, originalName) {
  const fallback = originalName || "未命名";
  const trimmed =
    typeof displayName === "string"
      ? displayName.replace(/[/\\]/g, "_").trim().slice(0, 180)
      : "";
  return trimmed || fallback.slice(0, 180);
}

/** 为升级库补齐 content_hash；内容重复则保留较早文档并删除副本 */
function backfillKnowledgeContentHashes() {
  const rows = database
    .prepare(
      `SELECT id, name, original_name AS originalName, content_hash AS contentHash,
              stored_path AS storedPath, created_at AS createdAt
       FROM knowledge_documents
       ORDER BY created_at ASC`,
    )
    .all();
  const seen = new Map();
  for (const row of rows) {
    let hash = row.contentHash;
    if (!hash) {
      try {
        hash = hashBuffer(readFileSync(row.storedPath));
      } catch {
        hash = `legacy-missing:${row.id}`;
      }
    }
    if (seen.has(hash)) {
      try {
        database.exec("BEGIN IMMEDIATE");
        deleteFtsForDocument(database, "library", row.id);
        deleteKnowledgeDocument.run(row.id);
        database.exec("COMMIT");
        try {
          unlinkSync(row.storedPath);
        } catch {}
      } catch {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      continue;
    }
    seen.set(hash, row.id);
    try {
      updateKnowledgeDocumentHashMeta.run(hash, row.name, row.id);
    } catch {
      // ignore
    }
  }
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_content_hash
        ON knowledge_documents(content_hash)
    `);
  } catch {
    // index may fail if duplicates remain; leave without unique until cleaned
  }
}

backfillKnowledgeContentHashes();

function mapConversationFileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    name: row.name,
    size: row.size,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    status: row.status ?? "ready",
    embeddingModel: row.embeddingModel ?? null,
    embeddingDim: row.embeddingDim ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function conversationAttachmentsDir(conversationId) {
  return resolve(attachmentsRootPath, conversationId);
}

/** 附件必须挂在已存在的对话上；禁止用旧 id「复活」空壳对话 */
function requireConversationExists(conversationId) {
  const existing = getConversation.get(conversationId);
  if (!existing) {
    const error = new Error("对话不存在");
    error.code = "CONVERSATION_NOT_FOUND";
    throw error;
  }
  return existing;
}

function removeConversationAttachmentDir(conversationId) {
  const dir = conversationAttachmentsDir(conversationId);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function deleteConversationWithFiles(conversationId) {
  const files = listConversationFilesByConversation.all(conversationId);
  const result = deleteConversation.run(conversationId);
  removeConversationAttachmentDir(conversationId);
  for (const file of files) {
    if (file.storedPath) {
      try {
        unlinkSync(file.storedPath);
      } catch {
        // ignore
      }
    }
  }
  return result;
}

function clearAllConversations() {
  const conversations = listConversations.all();
  clearConversations.run();
  for (const conversation of conversations) {
    removeConversationAttachmentDir(conversation.id);
  }
  if (existsSync(attachmentsRootPath)) {
    try {
      rmSync(attachmentsRootPath, { recursive: true, force: true });
      mkdirSync(attachmentsRootPath, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

function corsHeaders(request) {
  const origin = request?.headers?.origin;
  if (!origin) return {};
  if (!allowedOrigins.has(origin) && !isLoopbackOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

/** 请求处理期间设置，便于 json() 回写 CORS */
let currentHttpRequest = null;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...corsHeaders(currentHttpRequest),
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(
          chunks.length === 0
            ? {}
            : JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function readBuffer(request, maxBytes = 150 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        reject(new Error("文件不能超过 150 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function decodeFileName(value) {
  if (!value) return "未命名.bin";
  try {
    return decodeURIComponent(value).replace(/[/\\]/g, "_").slice(0, 180);
  } catch {
    return "未命名.bin";
  }
}

function extensionFromName(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

function contentTypeForName(name) {
  const ext = extensionFromName(name);
  if (ext === "pdf") return "application/pdf";
  if (ext === "md" || ext === "markdown") return "text/markdown; charset=utf-8";
  if (ext === "txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function resolveStoredFileMeta(fileRow, bytes) {
  const displayName = String(
    fileRow.originalName || fileRow.name || "file",
  );
  // 显示名常被去掉扩展名；优先 originalName / storedPath 推断 MIME
  const typeCandidates = [
    fileRow.originalName,
    fileRow.storedPath,
    fileRow.name,
  ].filter(Boolean);
  let contentType = "application/octet-stream";
  for (const candidate of typeCandidates) {
    const guessed = contentTypeForName(String(candidate));
    if (guessed !== "application/octet-stream") {
      contentType = guessed;
      break;
    }
  }
  if (contentType === "application/octet-stream" && isPdfMagicBuffer(bytes)) {
    contentType = "application/pdf";
  }
  // 下载/预览文件名尽量带扩展名
  let fileName = displayName;
  if (!extensionFromName(fileName)) {
    const fromPath = extensionFromName(fileRow.storedPath || "");
    const fromOriginal = extensionFromName(fileRow.originalName || "");
    const ext = fromOriginal || fromPath;
    if (ext) fileName = `${fileName}.${ext}`;
  }
  return { contentType, fileName };
}

function sendStoredFileBytes(response, fileRow, options = {}) {
  const headOnly = Boolean(options.headOnly);
  const storedPath = fileRow.storedPath;
  const stat = statSync(storedPath);
  // 只读文件头做 MIME 推断，避免大文件整包进内存阻塞事件循环
  const head = Buffer.alloc(Math.min(1024, stat.size));
  if (head.length > 0) {
    const fd = openSync(storedPath, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  }
  const { contentType, fileName } = resolveStoredFileMeta(fileRow, head);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "x-file-name": encodeURIComponent(fileName),
    "cache-control": "no-store",
  });
  if (headOnly) {
    response.end();
    return;
  }
  const stream = createReadStream(storedPath);
  stream.on("error", () => {
    if (!response.headersSent) {
      json(response, 404, { error: "原件文件不存在" });
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
}

function looksLikeTextBuffer(buffer) {
  if (!buffer.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 32)) weird += 1;
  }
  return weird / sample.length < 0.05;
}

function isPdfMagicBuffer(buffer) {
  const limit = Math.min(buffer.length, 1024);
  for (let i = 0; i <= limit - 5; i += 1) {
    if (
      buffer[i] === 0x25 &&
      buffer[i + 1] === 0x50 &&
      buffer[i + 2] === 0x44 &&
      buffer[i + 3] === 0x46 &&
      buffer[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Phase 1: store original bytes only. Parsing happens in services/knowledge.
 * Identity = contentHash; name is display-only metadata.
 */
function storeKnowledgeFile(
  buffer,
  {
    originalName,
    displayName,
    contentHash,
    kindHint,
  } = {},
) {
  const hash = contentHash || hashBuffer(buffer);
  const existing = getKnowledgeDocumentByHash.get(hash);
  if (existing) {
    const error = new Error("资料库已存在相同内容的文件");
    error.code = "DUPLICATE_CONTENT";
    error.document = mapDocumentRow(existing);
    throw error;
  }

  const sourceName = originalName || displayName || "未命名";
  const extFromName = extensionFromName(sourceName);
  let kind = kindHint;
  if (!kind) {
    if (isPdfMagicBuffer(buffer)) {
      kind = "pdf";
    } else if (extFromName === "md" || extFromName === "markdown") {
      kind = "md";
    } else if (extFromName === "txt" || looksLikeTextBuffer(buffer)) {
      kind = "txt";
    }
  }

  if (kind === "pdf") {
    if (!isPdfMagicBuffer(buffer)) {
      throw new Error("请选择有效的 PDF 文件");
    }
  } else if (kind === "txt" || kind === "md") {
    if (!looksLikeTextBuffer(buffer)) {
      throw new Error("请选择有效的文本文件");
    }
  } else {
    throw new Error("目前只支持 PDF、TXT、Markdown（.md）文件");
  }

  const ext = kind === "pdf" ? "pdf" : kind === "md" ? "md" : "txt";
  const original =
    sourceName && /\.[a-z0-9]+$/i.test(sourceName)
      ? sourceName
      : `${sourceName || "未命名"}.${ext}`;
  const name = normalizeDisplayName(displayName, original);

  const id = randomUUID();
  const storedPath = resolve(knowledgeFilesPath, `${id}.${ext}`);
  const createdAt = new Date().toISOString();
  const staged = storageStaging.writeAtomicFile({
    namespace: "library",
    documentId: id,
    finalPath: storedPath,
    buffer,
    contentHash: hash,
  });

  try {
    insertKnowledgeDocument.run(
      id,
      name,
      original,
      hash,
      storedPath,
      buffer.length,
      0,
      0,
      createdAt,
      "awaiting_chunks",
      null,
      null,
      null,
      createdAt,
    );
    storageStaging.markCommitted(staged.stagingId, id);
  } catch (error) {
    storageStaging.abort(staged.stagingId);
    try {
      unlinkSync(storedPath);
    } catch {}
    if (
      String(error?.message || "").includes("UNIQUE") ||
      String(error?.code || "").includes("CONSTRAINT")
    ) {
      const raced = getKnowledgeDocumentByHash.get(hash);
      if (raced) {
        const dup = new Error("资料库已存在相同内容的文件");
        dup.code = "DUPLICATE_CONTENT";
        dup.document = mapDocumentRow(raced);
        throw dup;
      }
    }
    throw error;
  }

  return mapDocumentRow(getKnowledgeDocument.get(id));
}

function renameKnowledgeDocument(documentId, nextName) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  const name = normalizeDisplayName(nextName, document.name);
  if (!name) throw new Error("显示名称不能为空");
  updateKnowledgeDocumentName.run(name, documentId);
  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

/** Phase 2: persist chunks produced by services/knowledge. */
function commitKnowledgeChunks(
  documentId,
  pageCount,
  chunks,
  {
    processingBuildId = null,
    activateProcessing = true,
    /** @type {Array<{ chunkId: string, refs: Array<{ blockId: string, startOffset?: number|null, endOffset?: number|null, bboxDegraded?: boolean }> }> | null} */
    chunkBlockRefs = null,
    /** @type {Array<{ chunkId: string, pageNumber: number, bboxDegraded?: boolean }> | null} */
    chunkLocators = null,
    __failAfterProcessingActivate = false,
  } = {},
) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("chunks 不能为空");
  }

  const atomicActivate =
    Boolean(processingBuildId) &&
    activateProcessing &&
    Array.isArray(chunkBlockRefs);

  /** @type {Array<{ id: string, content: string, pageNumber: number }>} */
  let storedChunks = [];
  /** @type {{ revisionId: string, processingBuildId: string, chunkSetId: string, keywordBuildId: string, vectorBuildId: string | null } | null} */
  let versioning = null;

  database.exec("BEGIN IMMEDIATE");
  try {
    deleteChunksForDocument.run(documentId);
    deleteFtsForDocument(database, "library", documentId);
    storedChunks = [];
    for (const chunk of chunks) {
      if (
        typeof chunk.pageNumber !== "number" ||
        typeof chunk.position !== "number" ||
        typeof chunk.content !== "string" ||
        !chunk.content.trim()
      ) {
        throw new Error("chunk 格式无效");
      }
      const chunkId =
        typeof chunk.id === "string" && chunk.id ? chunk.id : randomUUID();
      insertKnowledgeChunk.run(
        chunkId,
        documentId,
        chunk.pageNumber,
        chunk.position,
        chunk.content,
        null,
      );
      storedChunks.push({
        id: chunkId,
        content: chunk.content,
        pageNumber: chunk.pageNumber,
      });
    }
    upsertFtsChunks(database, "library", documentId, storedChunks);
    commitDocumentChunksMeta.run(
      pageCount,
      chunks.length,
      "ready",
      new Date().toISOString(),
      documentId,
    );

    if (Array.isArray(chunkLocators)) {
      documentBlockStore.replaceChunkLocatorsBatch("library", chunkLocators);
    }
    if (atomicActivate) {
      documentBlockStore.replaceChunkBlockRefsBatch("library", chunkBlockRefs);
    }

    const refreshed = getKnowledgeDocument.get(documentId);
    versioning = indexBuildStore.recordKeywordReady({
      namespace: "library",
      documentId,
      contentHash: refreshed.contentHash || `legacy:${documentId}`,
      strategyVersion: CHUNK_STRATEGY_VERSION,
      enqueueVector: semanticSearchEnabled(),
      vectorModel: EMBEDDING_CONFIG.modelName,
      vectorDim: EMBEDDING_CONFIG.dimension,
      processingBuildId,
      activateProcessing,
      inTransaction: true,
      __failAfterProcessingActivate,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  // 同步 native 路径：补齐 DocumentBlock（OCR 路径已有 blocks/refs 则跳过）
  if (!atomicActivate) {
    ensureNativeBlocksForChunks(
      versioning.processingBuildId,
      "library",
      storedChunks,
    );
  }
  // embed 入队在事务外：失败不影响已激活的 ProcessingBuild / keyword
  if (versioning.vectorBuildId) {
    try {
      jobRepository.enqueue({
        type: "embed_document",
        idempotencyKey: `embed:library:${documentId}:${versioning.vectorBuildId}`,
        payload: {
          namespace: "library",
          documentId,
          indexBuildId: versioning.vectorBuildId,
          chunkSetId: versioning.chunkSetId,
          revisionId: versioning.revisionId,
        },
      });
    } catch {
      // best-effort；可由后续 reconcile / 手动重试补齐
    }
  }

  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

/**
 * 若 ProcessingBuild 尚无 blocks，按 chunk 写入 native_text DocumentBlock + refs
 * @param {string | null | undefined} processingBuildId
 * @param {'library'|'conversation'} namespace
 * @param {Array<{ id: string, content: string, pageNumber: number }>} storedChunks
 */
function ensureNativeBlocksForChunks(processingBuildId, namespace, storedChunks) {
  if (!processingBuildId || !Array.isArray(storedChunks) || storedChunks.length === 0) {
    return;
  }
  try {
    const existing = documentBlockStore.listBlocks(processingBuildId);
    if (existing.length > 0) return;
    const blocks = storedChunks.map((chunk, index) => ({
      id: randomUUID(),
      pageNumber: chunk.pageNumber,
      readingOrder: index,
      text: chunk.content,
      origin: "native_text",
      bbox: null,
    }));
    documentBlockStore.replaceBlocksForBuild(processingBuildId, blocks);
    for (let i = 0; i < storedChunks.length; i += 1) {
      documentBlockStore.setChunkBlockRefs(namespace, storedChunks[i].id, [
        { blockId: blocks[i].id },
      ]);
    }
  } catch {
    // migration 未应用时忽略
  }
}

function setDocumentIndexStatus(
  documentId,
  status,
  { embeddingModel = null, embeddingDim = null, errorMessage = null } = {},
) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  // Phase 2：embedding 期间保留旧向量，供检索继续服务；新向量在 writeVectors 事务内替换。
  // 仅当 error 且没有仍可用的 active vector IndexBuild 时清空。
  if (status === "error") {
    const active = indexBuildStore.getActiveBuild(
      "library",
      documentId,
      "vector",
    );
    if (!active) {
      clearDocumentEmbeddings.run(documentId);
    }
  }
  updateDocumentStatus.run(
    status,
    embeddingModel,
    embeddingDim,
    errorMessage,
    new Date().toISOString(),
    documentId,
  );
  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

function recoverStaleEmbeddings() {
  const now = Date.now();
  for (const row of listKnowledgeDocuments.all()) {
    if (row.status !== "embedding") continue;
    const stamp = row.statusUpdatedAt || row.createdAt;
    const started = Date.parse(stamp);
    if (!Number.isFinite(started) || now - started < EMBEDDING_STALE_MS) {
      continue;
    }
    try {
      setDocumentIndexStatus(row.id, "error", {
        errorMessage: "向量索引中断或超时，请点击重建索引",
      });
    } catch {
      // best-effort
    }
  }
  for (const row of listConversationFilesForStale.all()) {
    if (row.status !== "embedding") continue;
    const stamp = row.statusUpdatedAt || row.createdAt;
    const started = Date.parse(stamp);
    if (!Number.isFinite(started) || now - started < EMBEDDING_STALE_MS) {
      continue;
    }
    try {
      setConversationFileIndexStatus(row.id, "error", {
        errorMessage: "向量索引中断或超时，请在对话中对该附件重建索引",
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * 资料库向量覆盖：有分块且可检索的文档中，已完成向量的比例。
 * 空库视为 vectorIndexReady=true（不阻塞 Auto→Balanced）。
 */
function getLibraryVectorCoverage() {
  recoverStaleEmbeddings();
  const docs = listKnowledgeDocuments.all().map(mapDocumentRow);
  const searchable = docs.filter(
    (doc) =>
      (doc.chunkCount ?? 0) > 0 &&
      ["ready", "embedding", "indexed", "error"].includes(doc.status),
  );
  const indexed = searchable.filter((doc) => doc.status === "indexed");
  const total = searchable.length;
  const indexedDocuments = indexed.length;
  return {
    totalDocuments: total,
    indexedDocuments,
    pendingDocuments: Math.max(0, total - indexedDocuments),
    vectorIndexReady: total === 0 || indexedDocuments > 0,
  };
}

/**
 * 语义开启时为缺少向量的文档补建 embed_document Job（幂等）。
 */
function reconcileLibraryVectorBackfill() {
  if (!semanticSearchEnabled()) {
    return { enqueued: 0, pending: 0 };
  }
  const coverage = getLibraryVectorCoverage();
  let enqueued = 0;
  for (const row of listKnowledgeDocuments.all()) {
    const doc = mapDocumentRow(row);
    if ((doc.chunkCount ?? 0) < 1) continue;
    if (doc.status === "indexed" || doc.status === "awaiting_chunks") continue;
    if (!["ready", "embedding", "error"].includes(doc.status)) continue;
    try {
      const key = `backfill:library:${doc.id}`;
      const existing = jobRepository.getByIdempotencyKey(key);
      if (existing) {
        if (
          existing.status === "failed" ||
          existing.status === "cancelled"
        ) {
          jobRepository.requeueFromTerminal(existing.id);
          enqueued += 1;
        } else if (
          existing.status === "succeeded" &&
          doc.status !== "indexed"
        ) {
          jobRepository.enqueue({
            type: "embed_document",
            idempotencyKey: `backfill:retry:library:${doc.id}:${Date.now()}`,
            payload: { namespace: "library", documentId: doc.id },
          });
          enqueued += 1;
        }
        continue;
      }
      jobRepository.enqueue({
        type: "embed_document",
        idempotencyKey: key,
        payload: { namespace: "library", documentId: doc.id },
      });
      enqueued += 1;
      if (doc.status === "ready" || doc.status === "error") {
        try {
          setDocumentIndexStatus(doc.id, "embedding", {});
        } catch {
          // ignore
        }
      }
    } catch {
      // best-effort
    }
  }
  return { enqueued, pending: coverage.pendingDocuments };
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!id || !name) return null;
      if (item.kind === "conversation_file") {
        return { id, name, kind: "conversation_file" };
      }
      if (item.kind === "library_all" || item.kind === "all") {
        return { id: "all", name: name || "全部资料", kind: "library_all" };
      }
      if (item.kind === "library" || item.kind === "document") {
        return { id, name, kind: "library" };
      }
      return null;
    })
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/** Phase 1: store conversation attachment bytes only. */
function storeConversationFile(buffer, name, kindHint, conversationId) {
  requireConversationExists(conversationId);
  const extFromName = extensionFromName(name);
  let kind = kindHint;
  if (!kind) {
    if (isPdfMagicBuffer(buffer)) {
      kind = "pdf";
    } else if (extFromName === "md" || extFromName === "markdown") {
      kind = "md";
    } else if (extFromName === "txt" || looksLikeTextBuffer(buffer)) {
      kind = "txt";
    }
  }

  if (kind === "pdf") {
    if (!isPdfMagicBuffer(buffer)) {
      throw new Error("请选择有效的 PDF 文件");
    }
  } else if (kind === "txt" || kind === "md") {
    if (!looksLikeTextBuffer(buffer)) {
      throw new Error("请选择有效的文本文件");
    }
  } else {
    throw new Error("目前只支持 PDF、TXT、Markdown（.md）文件");
  }

  const ext = kind === "pdf" ? "pdf" : kind === "md" ? "md" : "txt";
  const safeName =
    name && /\.[a-z0-9]+$/i.test(name) ? name : `${name || "未命名"}.${ext}`;

  const id = randomUUID();
  const dir = conversationAttachmentsDir(conversationId);
  mkdirSync(dir, { recursive: true });
  const storedPath = resolve(dir, `${id}.${ext}`);
  const createdAt = new Date().toISOString();
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const staged = storageStaging.writeAtomicFile({
    namespace: "conversation",
    documentId: id,
    finalPath: storedPath,
    buffer,
    contentHash,
  });

  try {
    insertConversationFile.run(
      id,
      conversationId,
      safeName,
      storedPath,
      buffer.length,
      0,
      0,
      createdAt,
      "awaiting_chunks",
      null,
      null,
      null,
      createdAt,
    );
    storageStaging.markCommitted(staged.stagingId, id);
  } catch (error) {
    storageStaging.abort(staged.stagingId);
    try {
      unlinkSync(storedPath);
    } catch {}
    throw error;
  }

  return mapConversationFileRow(getConversationFile.get(id));
}

function commitConversationFileChunks(
  fileId,
  pageCount,
  chunks,
  {
    processingBuildId = null,
    activateProcessing = true,
    chunkBlockRefs = null,
    chunkLocators = null,
  } = {},
) {
  const file = getConversationFile.get(fileId);
  if (!file) throw new Error("会话附件不存在");
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("chunks 不能为空");
  }

  const atomicActivate =
    Boolean(processingBuildId) &&
    activateProcessing &&
    Array.isArray(chunkBlockRefs);

  /** @type {Array<{ id: string, content: string, pageNumber: number }>} */
  let storedChunks = [];
  /** @type {{ revisionId: string, processingBuildId: string, chunkSetId: string, keywordBuildId: string, vectorBuildId: string | null } | null} */
  let versioning = null;

  database.exec("BEGIN IMMEDIATE");
  try {
    deleteChunksForConversationFile.run(fileId);
    deleteFtsForDocument(database, "conversation", fileId);
    storedChunks = [];
    for (const chunk of chunks) {
      if (
        typeof chunk.pageNumber !== "number" ||
        typeof chunk.position !== "number" ||
        typeof chunk.content !== "string" ||
        !chunk.content.trim()
      ) {
        throw new Error("chunk 格式无效");
      }
      const chunkId =
        typeof chunk.id === "string" && chunk.id ? chunk.id : randomUUID();
      insertConversationFileChunk.run(
        chunkId,
        fileId,
        chunk.pageNumber,
        chunk.position,
        chunk.content,
        null,
      );
      storedChunks.push({
        id: chunkId,
        content: chunk.content,
        pageNumber: chunk.pageNumber,
      });
    }
    upsertFtsChunks(database, "conversation", fileId, storedChunks);
    commitConversationFileChunksMeta.run(
      pageCount,
      chunks.length,
      "ready",
      new Date().toISOString(),
      fileId,
    );

    if (Array.isArray(chunkLocators)) {
      documentBlockStore.replaceChunkLocatorsBatch(
        "conversation",
        chunkLocators,
      );
    }
    if (atomicActivate) {
      documentBlockStore.replaceChunkBlockRefsBatch(
        "conversation",
        chunkBlockRefs,
      );
    }

    versioning = indexBuildStore.recordKeywordReady({
      namespace: "conversation",
      documentId: fileId,
      contentHash: `conversation:${fileId}`,
      strategyVersion: CHUNK_STRATEGY_VERSION,
      enqueueVector: semanticSearchEnabled(),
      vectorModel: EMBEDDING_CONFIG.modelName,
      vectorDim: EMBEDDING_CONFIG.dimension,
      processingBuildId,
      activateProcessing,
      inTransaction: true,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  if (!atomicActivate) {
    ensureNativeBlocksForChunks(
      versioning.processingBuildId,
      "conversation",
      storedChunks,
    );
  }
  if (versioning.vectorBuildId) {
    try {
      jobRepository.enqueue({
        type: "embed_document",
        idempotencyKey: `embed:conversation:${fileId}:${versioning.vectorBuildId}`,
        payload: {
          namespace: "conversation",
          documentId: fileId,
          indexBuildId: versioning.vectorBuildId,
          chunkSetId: versioning.chunkSetId,
          revisionId: versioning.revisionId,
        },
      });
    } catch {
      // best-effort
    }
  }

  return mapConversationFileRow(getConversationFile.get(fileId));
}

function setConversationFileIndexStatus(
  fileId,
  status,
  { embeddingModel = null, embeddingDim = null, errorMessage = null } = {},
) {
  const file = getConversationFile.get(fileId);
  if (!file) throw new Error("会话附件不存在");
  if (status === "error") {
    const active = indexBuildStore.getActiveBuild(
      "conversation",
      fileId,
      "vector",
    );
    if (!active) {
      clearConversationFileEmbeddings.run(fileId);
    }
  }
  updateConversationFileStatus.run(
    status,
    embeddingModel,
    embeddingDim,
    errorMessage,
    new Date().toISOString(),
    fileId,
  );
  return mapConversationFileRow(getConversationFile.get(fileId));
}

function queryRetrievalChunks({ library, conversationFiles, withVectors }) {
  const chunks = [];

  if (library) {
    const mode = library.mode === "all" ? "all" : "documents";
    let rows;
    if (mode === "all") {
      rows = withVectors
        ? listAllChunksWithVectors.all()
        : listAllKnowledgeChunks.all();
    } else {
      const documentIds = Array.isArray(library.documentIds)
        ? library.documentIds.filter((id) => typeof id === "string")
        : [];
      if (documentIds.length > 0) {
        const idsJson = JSON.stringify(documentIds);
        rows = withVectors
          ? listChunksWithVectorsByDocuments.all(idsJson)
          : listKnowledgeChunksByDocuments.all(idsJson);
      } else {
        rows = [];
      }
    }
    const versionCache = new Map();
    for (const row of rows) {
      if (
        withVectors &&
        !indexBuildStore.isLibraryDocumentVectorEligible(row.documentId)
      ) {
        // 有 vector IndexBuild 但无 active ready：跳过该文档的向量候选
        continue;
      }
      let version = versionCache.get(row.documentId);
      if (version === undefined) {
        version =
          indexBuildStore.getActiveKeywordVersion("library", row.documentId) ??
          null;
        versionCache.set(row.documentId, version);
      }
      chunks.push({
        id: row.id,
        documentId: row.documentId,
        documentName: row.documentName,
        pageNumber: row.pageNumber,
        position: row.position,
        content: row.content,
        source: "library",
        ...(version
          ? {
              revisionId: version.revisionId,
              processingBuildId: version.processingBuildId,
            }
          : {}),
        ...(withVectors
          ? { embedding: embeddingToArray(row.embedding) }
          : {}),
      });
    }
  }

  if (conversationFiles) {
    const conversationId =
      typeof conversationFiles.conversationId === "string"
        ? conversationFiles.conversationId.trim()
        : "";
    const fileIds = Array.isArray(conversationFiles.fileIds)
      ? conversationFiles.fileIds.filter((id) => typeof id === "string")
      : [];
    // 无 conversationId 时不返回任何会话片段，防止跨会话按 fileId 捞取
    if (conversationId && fileIds.length > 0) {
      const idsJson = JSON.stringify(fileIds);
      const rows = withVectors
        ? listConversationChunksWithVectorsByFiles.all(
            idsJson,
            conversationId,
          )
        : listConversationChunksByFiles.all(idsJson, conversationId);
      const versionCache = new Map();
      for (const row of rows) {
        let version = versionCache.get(row.documentId);
        if (version === undefined) {
          version =
            indexBuildStore.getActiveKeywordVersion(
              "conversation",
              row.documentId,
            ) ?? null;
          versionCache.set(row.documentId, version);
        }
        chunks.push({
          id: row.id,
          documentId: row.documentId,
          documentName: row.documentName,
          pageNumber: row.pageNumber,
          position: row.position,
          content: row.content,
          source: "conversation_file",
          ...(version
            ? {
                revisionId: version.revisionId,
                processingBuildId: version.processingBuildId,
              }
            : {}),
          ...(withVectors
            ? { embedding: embeddingToArray(row.embedding) }
            : {}),
        });
      }
    }
  }

  return chunks;
}

function parseStoredAttachments(raw) {
  if (raw == null || raw === "") return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeAttachments(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

function parseJsonField(raw) {
  if (raw == null || raw === "") return undefined;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

function mapMessageRow(row) {
  const attachments = parseStoredAttachments(row.attachments);
  const citations = parseJsonField(row.citations);
  const referencedCitationIds = parseJsonField(row.referencedCitationIds);
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    durationMs: row.durationMs ?? undefined,
    ...(attachments ? { attachments } : {}),
    ...(Array.isArray(citations) ? { citations } : {}),
    ...(Array.isArray(referencedCitationIds)
      ? { referencedCitationIds }
      : {}),
    ...(typeof row.retrievalTraceId === "string" && row.retrievalTraceId
      ? { retrievalTraceId: row.retrievalTraceId }
      : {}),
  };
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  return messages.map((message, position) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      throw new Error(`Invalid message at position ${position}`);
    }
    const durationMs =
      typeof message.durationMs === "number" &&
      Number.isFinite(message.durationMs) &&
      message.durationMs > 0
        ? Math.round(message.durationMs)
        : null;
    const attachments = normalizeAttachments(message.attachments);
    const citations = Array.isArray(message.citations)
      ? message.citations
      : null;
    const referencedCitationIds = Array.isArray(message.referencedCitationIds)
      ? message.referencedCitationIds.filter(
          (id) => typeof id === "string" && id,
        )
      : null;
    const retrievalTraceId =
      typeof message.retrievalTraceId === "string" &&
      message.retrievalTraceId.trim()
        ? message.retrievalTraceId.trim()
        : null;
    return {
      id: typeof message.id === "string" ? message.id : randomUUID(),
      role: message.role,
      content: message.content,
      createdAt:
        typeof message.createdAt === "string"
          ? message.createdAt
          : new Date().toISOString(),
      durationMs,
      attachments,
      citations,
      referencedCitationIds,
      retrievalTraceId,
      position,
    };
  });
}

/**
 * 保存会话。
 * - 仅当 body 显式带 messages 数组时替换消息（含 [] 表示刻意清空/建空会话）
 * - 未带 messages 时只更新 title，绝不误删历史消息
 */
function saveConversation(input, id = randomUUID()) {
  const existing = getConversation.get(id);
  const now = new Date().toISOString();
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 80)
      : existing?.title || "新对话";
  const replaceMessages = Array.isArray(input.messages);
  const messages = replaceMessages ? validateMessages(input.messages) : null;
  const createdAt = existing?.createdAt ?? now;

  database.exec("BEGIN IMMEDIATE");
  try {
    upsertConversation.run(id, title, createdAt, now);
    if (replaceMessages) {
      deleteMessages.run(id);
      for (const message of messages) {
        insertMessage.run(
          message.id,
          id,
          message.role,
          message.content,
          message.createdAt,
          message.position,
          message.durationMs,
          message.attachments ? JSON.stringify(message.attachments) : null,
          message.citations ? JSON.stringify(message.citations) : null,
          message.referencedCitationIds
            ? JSON.stringify(message.referencedCitationIds)
            : null,
          message.retrievalTraceId,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    id,
    title,
    createdAt,
    updatedAt: now,
    messages: getMessages.all(id).map(mapMessageRow),
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRuntimeSettings(input = {}) {
  const maxContext = Number(input.maxContext);
  const tierRaw = String(input.knowledgeTier || "").toLowerCase();
  const knowledgeTier =
    tierRaw === "auto" ||
    tierRaw === "balanced" ||
    tierRaw === "quality" ||
    tierRaw === "lite"
      ? tierRaw
      : DEFAULT_RUNTIME_SETTINGS.knowledgeTier;
  const ocrRaw = String(input.ocrMode || "").toLowerCase();
  const ocrMode = ocrRaw === "disabled" ? "disabled" : "auto";
  return {
    temperature: Number(
      clampNumber(input.temperature, 0, 2, DEFAULT_RUNTIME_SETTINGS.temperature).toFixed(2),
    ),
    topP: Number(
      clampNumber(input.topP, 0.01, 1, DEFAULT_RUNTIME_SETTINGS.topP).toFixed(2),
    ),
    topK: Math.round(clampNumber(input.topK, 0, 256, DEFAULT_RUNTIME_SETTINGS.topK)),
    maxContext: ALLOWED_MAX_CONTEXT.has(maxContext)
      ? maxContext
      : DEFAULT_RUNTIME_SETTINGS.maxContext,
    maxTokens: Math.round(
      clampNumber(input.maxTokens, 0, 65536, DEFAULT_RUNTIME_SETTINGS.maxTokens),
    ),
    knowledgeTier,
    ocrMode,
  };
}

function readRuntimeSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return normalizeRuntimeSettings(raw);
  } catch {
    return { ...DEFAULT_RUNTIME_SETTINGS };
  }
}

function writeRuntimeSettings(input) {
  const settings = normalizeRuntimeSettings(input);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function readAppliedMaxContext() {
  try {
    const raw = JSON.parse(readFileSync(turboAppliedPath, "utf8"));
    const value = Number(raw.maxContext);
    return ALLOWED_MAX_CONTEXT.has(value) ? value : null;
  } catch {
    return null;
  }
}

function settingsResponsePayload(settings) {
  const appliedMaxContext = readAppliedMaxContext();
  return {
    settings,
    settingsPath,
    defaults: DEFAULT_RUNTIME_SETTINGS,
    allowedMaxContext: [...ALLOWED_MAX_CONTEXT],
    appliedMaxContext,
    maxContextRestartRequired:
      appliedMaxContext != null && appliedMaxContext !== settings.maxContext,
  };
}

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.has(origin) || isLoopbackOrigin(origin);
}

const activeEmbedArtifact = getActiveEmbeddingArtifact();
const EMBED_MODEL = activeEmbedArtifact.xenovaModelId;
const EMBED_DIM = activeEmbedArtifact.dimension;
const EMBED_REVISION = activeEmbedArtifact.revision;
let embedPipelinePromise = null;
let embedUnavailableReason = null;

async function resolveEmbedPipeline() {
  if (embedUnavailableReason) {
    throw new Error(embedUnavailableReason);
  }
  if (!embedPipelinePromise) {
    embedPipelinePromise = (async () => {
      let pipeline;
      try {
        ({ pipeline } = await import("@xenova/transformers"));
      } catch {
        embedUnavailableReason =
          "未安装 @xenova/transformers。执行: npm install @xenova/transformers";
        throw new Error(embedUnavailableReason);
      }
      // Prefer project-local cache under .orynode
      try {
        const { env } = await import("@xenova/transformers");
        env.cacheDir = resolve(projectRoot, ".orynode/models/transformers");
      } catch {
        // older package shapes may not expose env; continue
      }
      console.log(
        `Loading embedding artifact ${activeEmbedArtifact.id} (${EMBED_MODEL})...`,
      );
      const extractor = await pipeline("feature-extraction", EMBED_MODEL);
      console.log("Embedding model ready");
      return extractor;
    })().catch((error) => {
      embedPipelinePromise = null;
      throw error;
    });
  }
  return embedPipelinePromise;
}

function embedStatusBase(extra = {}) {
  return {
    available: false,
    ready: false,
    artifactId: activeEmbedArtifact.id,
    model: activeEmbedArtifact.id,
    xenovaModelId: EMBED_MODEL,
    modelRevision: EMBED_REVISION,
    dimension: EMBED_DIM,
    role: activeEmbedArtifact.role,
    queryTemplate: activeEmbedArtifact.queryTemplate,
    passageTemplate: activeEmbedArtifact.passageTemplate,
    fingerprint: embeddingConfigFingerprint(activeEmbedArtifact),
    ...extra,
  };
}

async function getEmbedStatus() {
  if (embedUnavailableReason) {
    return embedStatusBase({
      reason: embedUnavailableReason,
    });
  }
  try {
    await resolveEmbedPipeline();
    return embedStatusBase({
      available: true,
      ready: true,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "向量模型不可用";
    return embedStatusBase({ reason });
  }
}

/**
 * @param {string[]} texts
 * @param {"query" | "passage"} [mode]
 */
async function embedTexts(texts, mode = "passage") {
  const extractor = await resolveEmbedPipeline();
  const artifact = getActiveEmbeddingArtifact();
  const template =
    mode === "query" ? artifact.queryTemplate : artifact.passageTemplate;
  const maxChars = artifact.maxInputChars || 8000;
  const vectors = [];
  for (const text of texts) {
    const prepared = applyEmbeddingTemplate(template, text).slice(0, maxChars);
    const result = await extractor(prepared, {
      pooling: artifact.pooling || "mean",
      normalize: artifact.normalization !== false,
    });
    vectors.push(Array.from(result.data));
  }
  return vectors;
}

async function setDocumentStatusForWorker(
  namespace,
  documentId,
  status,
  extra = {},
) {
  if (namespace === "conversation") {
    return setConversationFileIndexStatus(documentId, status, extra);
  }
  return setDocumentIndexStatus(documentId, status, extra);
}

/**
 * Worker 用：读取 chunks → embed → 写入 vector_entries(index_build_id)
 * 不触碰旧 active build 的 entries，也不清空 legacy embedding（expand 兼容）。
 */
async function writeVectorsForDocument({
  namespace,
  documentId,
  indexBuildId,
  embedTexts: embedFn,
  onProgress,
}) {
  if (!indexBuildId) {
    throw new Error("writeVectors 需要 indexBuildId");
  }
  const build = indexBuildStore.getBuild(indexBuildId);
  if (!build || build.kind !== "vector") {
    throw new Error("vector IndexBuild 不存在");
  }
  if (build.documentId !== documentId || build.namespace !== namespace) {
    throw new Error("IndexBuild 与文档不匹配");
  }

  const rows =
    namespace === "conversation"
      ? getConversationFileChunks.all(documentId)
      : getKnowledgeChunks.all(documentId);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("文档没有可用分块");
  }

  const batchSize = Math.max(1, EMBEDDING_CONFIG.batchSize);
  /** @type {Array<{ chunkId: string, embedding: Buffer }>} */
  const entries = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const slice = rows.slice(offset, offset + batchSize);
    const embedded = await embedFn(slice.map((row) => row.content));
    for (let i = 0; i < slice.length; i += 1) {
      const vector = embedded[i];
      if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
        throw new Error("embedding 返回格式无效");
      }
      const floats = Float32Array.from(vector);
      for (let j = 0; j < floats.length; j += 1) {
        if (!Number.isFinite(floats[j])) {
          throw new Error("embedding 含非有限值");
        }
      }
      entries.push({
        chunkId: slice[i].id,
        embedding: arrayToEmbeddingBlob(floats),
      });
    }
    onProgress?.({
      phase: "embedding",
      done: Math.min(offset + slice.length, rows.length),
      total: rows.length,
    });
  }

  vectorEntryStore.replaceAll(indexBuildId, entries);
  const expectedDim =
    typeof build.dimension === "number" && build.dimension > 0
      ? build.dimension
      : EMBED_DIM;
  vectorEntryStore.validateBuild(indexBuildId, {
    expectedCount: entries.length,
    expectedDim,
  });

  // expand：同步 dual-write legacy 列（不在激活前清空；激活后检索优先 vector_entries）
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of entries) {
      if (namespace === "conversation") {
        updateConversationChunkEmbedding.run(entry.embedding, entry.chunkId);
      } else {
        updateChunkEmbedding.run(entry.embedding, entry.chunkId);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    // entries 已写入新 build；legacy dual-write 失败不回滚 entries
    console.warn("[writeVectors] legacy dual-write failed", error);
  }

  return {
    chunkCount: entries.length,
    model: activeEmbedArtifact.id,
    modelRevision: EMBED_REVISION,
    dimension: expectedDim,
    indexBuildId,
    artifactId: activeEmbedArtifact.id,
    role: activeEmbedArtifact.role,
  };
}

const indexWorker = startIndexWorker({
  jobs: jobRepository,
  indexBuilds: indexBuildStore,
  vectorEntries: vectorEntryStore,
  resources: resourceCoordinator,
  embedEnabled: semanticSearchEnabled,
  embedTexts,
  writeVectors: writeVectorsForDocument,
  setDocumentStatus: setDocumentStatusForWorker,
  runSyncSource: runSyncSourceJob,
  runProcessRevision: runProcessRevisionJob,
  runGarbageCollect: (payload) => {
    const targets = Array.isArray(payload?.targets)
      ? payload.targets
      : ["agent_spaces"];
    const result = { agentSpacesExpired: 0 };
    if (targets.includes("agent_spaces")) {
      const before = database
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_spaces
           WHERE kind = 'agent' AND status = 'active'
             AND expires_at IS NOT NULL AND expires_at < ?`,
        )
        .get(new Date().toISOString());
      agentSpaceStore.gcExpired();
      result.agentSpacesExpired = Number(before?.n || 0);
    }
    return result;
  },
  log: console,
});

// 每日幂等入队一次 agent space GC（启动时立即尝试）
try {
  const dayKey = new Date().toISOString().slice(0, 10);
  jobRepository.enqueue({
    type: "garbage_collect",
    idempotencyKey: `gc:agent-spaces:${dayKey}`,
    payload: { targets: ["agent_spaces"] },
    maxAttempts: 2,
  });
} catch {
  // ignore duplicate / missing table during early boot
}

// 语义开启时为已有文档补建向量（Chat 活跃时由 worker defer）
try {
  if (semanticSearchEnabled()) {
    const result = reconcileLibraryVectorBackfill();
    if (result.enqueued > 0) {
      console.log(
        `[vector-backfill] enqueued ${result.enqueued} (pending ${result.pending})`,
      );
    }
  }
} catch (error) {
  console.warn("[vector-backfill] startup reconcile failed", error);
}

const server = createServer(async (request, response) => {
  currentHttpRequest = request;
  try {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders(request),
      "access-control-max-age": "86400",
    });
    response.end();
    return;
  }

  if (!originAllowed(request)) {
    json(response, 403, { error: "Origin is not allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        service: "orynode-local-data",
        databasePath,
        embed: {
          model: activeEmbedArtifact.id,
          artifactId: activeEmbedArtifact.id,
          dimension: EMBED_DIM,
          role: activeEmbedArtifact.role,
        },
        worker: { id: indexWorker.workerId },
        resources: resourceCoordinator.snapshot(),
      });
      return;
    }

    // Trusted-LAN 管理面：仅 loopback Data Service 可达，供本机 Settings 直连
    if (url.pathname === "/lan-auth/pairing") {
      if (request.method === "GET") {
        json(response, 200, {
          sessions: lanAuthStore.listSessions(),
          unsafePreview:
            process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "1" ||
            process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "true",
        });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const action = body.action === "claim" ? "claim" : "start";
        if (action === "start") {
          const challenge = lanAuthStore.startPairing();
          json(response, 200, {
            pairing: {
              code: challenge.code,
              expiresAt: challenge.expiresAt,
            },
          });
          return;
        }
        const claimed = lanAuthStore.claimPairing({
          code: String(body.code || ""),
          label: typeof body.label === "string" ? body.label : undefined,
        });
        if (!claimed) {
          json(response, 400, {
            error: "配对码无效或已过期",
            code: "PAIRING_INVALID",
          });
          return;
        }
        json(response, 200, {
          token: claimed.token,
          session: {
            id: claimed.session.id,
            label: claimed.session.label,
            expiresAt: claimed.session.expiresAt,
          },
        });
        return;
      }
      if (request.method === "DELETE") {
        const body = await readJson(request);
        const id = String(body.sessionId || "");
        if (!id) {
          json(response, 400, { error: "需要 sessionId" });
          return;
        }
        const ok = lanAuthStore.revokeSession(id);
        json(response, ok ? 200 : 404, { revoked: ok });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/resources/chat") {
      const body = await readJson(request);
      if (body.active === false) {
        const token =
          typeof body.token === "string" ? body.token : undefined;
        resourceCoordinator.markChatIdle(token);
      } else {
        const ttl = Number(body.ttlMs);
        const existing =
          typeof body.token === "string" ? body.token : null;
        if (
          existing &&
          resourceCoordinator.touchChat(
            existing,
            Number.isFinite(ttl) && ttl > 0 ? ttl : 120_000,
          )
        ) {
          json(response, 200, {
            ...resourceCoordinator.snapshot(),
            token: existing,
          });
          return;
        }
        const token = resourceCoordinator.markChatActive(
          Number.isFinite(ttl) && ttl > 0 ? ttl : 120_000,
        );
        json(response, 200, { ...resourceCoordinator.snapshot(), token });
        return;
      }
      json(response, 200, resourceCoordinator.snapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/resources") {
      json(response, 200, resourceCoordinator.snapshot());
      return;
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJson(request);
      if (!body?.type || !body?.idempotencyKey) {
        json(response, 400, { error: "type 与 idempotencyKey 必填" });
        return;
      }
      const idempotencyKey = String(body.idempotencyKey);
      const existingJob = jobRepository.getByIdempotencyKey(idempotencyKey);
      if (existingJob) {
        // 旧 Job 缺 V1 字段时补齐（不新建 build）
        if (
          String(body.type) === "process_revision" &&
          (!existingJob.payload?.processingBuildId ||
            !existingJob.payload?.revisionId)
        ) {
          try {
            const enriched = await ensureProcessRevisionPayload(
              { ...existingJob.payload, ...(body.payload ?? {}) },
              { ocrMode: body.payload?.ocrMode ?? existingJob.payload?.ocrMode },
            );
            jobRepository.mergePayload(existingJob.id, {
              version: 1,
              namespace: enriched.namespace,
              documentId: enriched.documentId,
              revisionId: enriched.revisionId,
              processingBuildId: enriched.processingBuildId,
              ocrMode: enriched.ocrMode,
            });
          } catch (error) {
            json(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
        json(response, 201, { job: jobRepository.get(existingJob.id) });
        return;
      }

      let payload = body.payload ?? {};
      if (String(body.type) === "process_revision") {
        try {
          payload = await ensureProcessRevisionPayload(payload, {
            ocrMode: payload?.ocrMode,
          });
        } catch (error) {
          json(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      const job = jobRepository.enqueue({
        type: String(body.type),
        payload,
        idempotencyKey,
        maxAttempts: body.maxAttempts,
        availableAt: body.availableAt,
      });
      json(response, 201, { job });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/jobs/by-idempotency"
    ) {
      const key = String(url.searchParams.get("key") || "").trim();
      if (!key) {
        json(response, 400, { error: "key 必填" });
        return;
      }
      const job = jobRepository.getByIdempotencyKey(key);
      if (!job) {
        json(response, 404, { error: "任务不存在" });
        return;
      }
      json(response, 200, { job });
      return;
    }

    if (request.method === "GET" && parts[0] === "jobs" && parts.length === 2) {
      const job = jobRepository.get(parts[1]);
      if (!job) {
        json(response, 404, { error: "任务不存在" });
        return;
      }
      json(response, 200, { job });
      return;
    }

    if (
      request.method === "POST" &&
      parts[0] === "jobs" &&
      parts.length === 3 &&
      parts[2] === "cancel"
    ) {
      const ok = jobRepository.cancel(parts[1]);
      json(response, ok ? 200 : 409, { cancelled: ok });
      return;
    }

    if (request.method === "POST" && url.pathname === "/agent-spaces") {
      const body = await readJson(request);
      const ownerRef = String(body.ownerRef || "").trim();
      if (!ownerRef) {
        json(response, 400, { error: "ownerRef 必填" });
        return;
      }
      const existing = agentSpaceStore.getByOwner(ownerRef);
      if (existing) {
        json(response, 200, { space: existing });
        return;
      }
      json(response, 201, {
        space: agentSpaceStore.create({
          ownerRef,
          maxDocuments: body.maxDocuments,
          maxOpenChunks: body.maxOpenChunks,
          ttlHours: body.ttlHours,
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/agent-spaces") {
      const ownerRef = String(url.searchParams.get("ownerRef") || "").trim();
      if (!ownerRef) {
        json(response, 400, { error: "ownerRef 必填" });
        return;
      }
      const space = agentSpaceStore.getByOwner(ownerRef);
      if (!space) {
        json(response, 404, { error: "Agent space 不存在" });
        return;
      }
      json(response, 200, { space });
      return;
    }

    if (
      request.method === "GET" &&
      parts[0] === "agent-spaces" &&
      parts.length === 2
    ) {
      const space = agentSpaceStore.get(parts[1]);
      if (!space) {
        json(response, 404, { error: "Agent space 不存在" });
        return;
      }
      json(response, 200, { space });
      return;
    }

    if (
      request.method === "POST" &&
      parts[0] === "agent-spaces" &&
      parts.length === 3 &&
      parts[2] === "documents"
    ) {
      const body = await readJson(request);
      const documentId = String(body.documentId || "").trim();
      if (!documentId) {
        json(response, 400, { error: "documentId 必填" });
        return;
      }
      try {
        const space = agentSpaceStore.bindDocument(parts[1], documentId);
        json(response, 200, { space });
      } catch (error) {
        json(response, 409, {
          error: error instanceof Error ? error.message : "绑定失败",
        });
      }
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/index-builds/active"
    ) {
      const namespace =
        url.searchParams.get("namespace") === "conversation"
          ? "conversation"
          : "library";
      const documentId = String(url.searchParams.get("documentId") || "").trim();
      const kind =
        url.searchParams.get("kind") === "keyword" ? "keyword" : "vector";
      if (!documentId) {
        json(response, 400, { error: "documentId 不能为空" });
        return;
      }
      json(response, 200, {
        build: indexBuildStore.getActiveBuild(namespace, documentId, kind),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/knowledge/embed/status") {
      json(response, 200, await getEmbedStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/knowledge/embed") {
      const body = await readJson(request);
      const texts = Array.isArray(body.texts) ? body.texts : null;
      if (!texts || texts.length === 0) {
        json(response, 400, { error: "texts 数组不能为空" });
        return;
      }
      if (texts.length > 64) {
        json(response, 400, { error: "单次最多 64 条文本" });
        return;
      }
      const mode = body.mode === "query" ? "query" : "passage";
      const vectors = await embedTexts(texts, mode);
      json(response, 200, {
        artifactId: activeEmbedArtifact.id,
        model: activeEmbedArtifact.id,
        modelRevision: EMBED_REVISION,
        dimension: EMBED_DIM,
        role: activeEmbedArtifact.role,
        mode,
        vectors,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/settings") {
      json(response, 200, settingsResponsePayload(readRuntimeSettings()));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/settings") {
      const body = await readJson(request);
      const settings = writeRuntimeSettings(body.settings ?? body);
      const payload = settingsResponsePayload(settings);
      json(response, 200, {
        ...payload,
        // 相对「当前模型进程已应用的上下文」是否需要重启
        restartRequired: payload.maxContextRestartRequired,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/conversations") {
      json(response, 200, { conversations: listConversations.all() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/knowledge") {
      recoverStaleEmbeddings();
      json(response, 200, {
        documents: listKnowledgeDocuments.all().map(mapDocumentRow),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/knowledge/vector-coverage") {
      json(response, 200, getLibraryVectorCoverage());
      return;
    }

    if (request.method === "POST" && url.pathname === "/knowledge/vector-backfill") {
      if (!semanticSearchEnabled()) {
        json(response, 200, {
          enqueued: 0,
          pending: 0,
          skipped: true,
          reason: "semantic_search_disabled",
        });
        return;
      }
      const result = reconcileLibraryVectorBackfill();
      json(response, 200, { ...result, coverage: getLibraryVectorCoverage() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/knowledge/export") {
      const outDir = resolve(
        projectRoot,
        `.orynode/exports/knowledge-${Date.now()}`,
      );
      try {
        const result = exportKnowledgePackage({
          projectRoot,
          databasePath,
          knowledgeFilesPath,
          outDir,
        });
        json(response, 200, {
          exportDir: result.outDir,
          documentCount: result.documentCount,
          manifest: result.manifest,
        });
      } catch (error) {
        json(response, 500, {
          error: error instanceof Error ? error.message : "导出失败",
        });
      }
      return;
    }

    // Phase 1: store original file only (no parsing in data service)
    if (request.method === "POST" && url.pathname === "/knowledge") {
      const contentType = String(request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowed = new Set([
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
      ]);
      if (!allowed.has(contentType)) {
        json(response, 415, {
          error: "目前只支持 PDF、TXT、Markdown（.md）文件",
        });
        return;
      }
      const kindHeader = String(request.headers["x-file-kind"] || "")
        .trim()
        .toLowerCase();
      const kindHint =
        kindHeader === "pdf" || kindHeader === "txt" || kindHeader === "md"
          ? kindHeader
          : contentType === "application/pdf"
            ? "pdf"
            : contentType === "text/markdown" ||
                contentType === "text/x-markdown"
              ? "md"
              : "txt";
      const buffer = await readBuffer(request);
      const originalName = decodeFileName(request.headers["x-file-name"]);
      const displayHeader = request.headers["x-display-name"];
      const displayName = displayHeader
        ? decodeFileName(displayHeader)
        : undefined;
      const contentHashHeader = String(
        request.headers["x-content-hash"] || "",
      ).trim();
      const contentHash =
        /^[a-f0-9]{64}$/i.test(contentHashHeader)
          ? contentHashHeader.toLowerCase()
          : hashBuffer(buffer);
      try {
        json(response, 201, {
          document: storeKnowledgeFile(buffer, {
            originalName,
            displayName,
            contentHash,
            kindHint,
          }),
        });
      } catch (error) {
        if (error?.code === "DUPLICATE_CONTENT" && error.document) {
          json(response, 409, {
            error: error.message,
            document: error.document,
            deduplicated: true,
          });
          return;
        }
        throw error;
      }
      return;
    }

    if (
      request.method === "GET" &&
      parts[0] === "knowledge" &&
      parts[1] === "by-hash" &&
      parts.length === 3
    ) {
      const hash = String(parts[2] || "")
        .trim()
        .toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        json(response, 400, { error: "content hash 无效" });
        return;
      }
      const document = getKnowledgeDocumentByHash.get(hash);
      if (!document) {
        json(response, 404, { error: "资料不存在" });
        return;
      }
      json(response, 200, { document: mapDocumentRow(document) });
      return;
    }

    // FTS5 keyword search — returns top candidates only (Phase 1)
    if (request.method === "POST" && url.pathname === "/retrieval/keyword/search") {
      const body = await readJson(request);
      const query = typeof body.query === "string" ? body.query : "";
      const hasLibrary = Boolean(body.library);
      const hasFiles = Boolean(body.conversationFiles);
      if (!hasLibrary && !hasFiles) {
        json(response, 400, { error: "至少指定 library 或 conversationFiles" });
        return;
      }
      const topK = Number(body.topK);
      const result = searchKeywordIndex(database, {
        query,
        phrase: typeof body.phrase === "string" ? body.phrase : undefined,
        terms: Array.isArray(body.terms) ? body.terms : undefined,
        exactTerms: Array.isArray(body.exactTerms) ? body.exactTerms : undefined,
        preferLegacy: body.preferLegacy === true,
        library: body.library,
        conversationFiles: body.conversationFiles,
        topK: Number.isFinite(topK) && topK > 0 ? topK : 8,
      });
      const versionCache = new Map();
      const chunks = (result.chunks ?? []).map((chunk) => {
        const ns =
          chunk.source === "conversation_file" ? "conversation" : "library";
        const cacheKey = `${ns}:${chunk.documentId}`;
        let version = versionCache.get(cacheKey);
        if (version === undefined) {
          version =
            indexBuildStore.getActiveKeywordVersion(ns, chunk.documentId) ??
            null;
          versionCache.set(cacheKey, version);
        }
        return version
          ? {
              ...chunk,
              revisionId: version.revisionId,
              processingBuildId: version.processingBuildId,
            }
          : chunk;
      });
      json(response, 200, { ...result, chunks });
      return;
    }

    // Open chunk by id (Agent knowledge.open / citation resolve)
    if (
      request.method === "GET" &&
      parts[0] === "retrieval" &&
      parts[1] === "chunks" &&
      parts.length === 3
    ) {
      const chunkId = String(parts[2] || "").trim();
      if (!chunkId) {
        json(response, 400, { error: "chunk id 不能为空" });
        return;
      }
      const library = getLibraryChunkById.get(chunkId);
      if (library) {
        const version = indexBuildStore.getActiveKeywordVersion(
          "library",
          library.documentId,
        );
        json(response, 200, {
          chunk: {
            ...library,
            source: "library",
            score: 0,
            ...(version
              ? {
                  revisionId: version.revisionId,
                  processingBuildId: version.processingBuildId,
                }
              : {}),
          },
        });
        return;
      }
      const conversation = getConversationChunkById.get(chunkId);
      if (conversation) {
        const version = indexBuildStore.getActiveKeywordVersion(
          "conversation",
          conversation.documentId,
        );
        json(response, 200, {
          chunk: {
            ...conversation,
            source: "conversation_file",
            score: 0,
            ...(version
              ? {
                  revisionId: version.revisionId,
                  processingBuildId: version.processingBuildId,
                }
              : {}),
          },
        });
        return;
      }
      json(response, 404, { error: "chunk 不存在", chunk: null });
      return;
    }

    // Unified retrieval chunk export (library + conversation files)
    if (request.method === "POST" && url.pathname === "/retrieval/chunks/query") {
      const body = await readJson(request);
      const withVectors = Boolean(body.withVectors);
      const hasLibrary = Boolean(body.library);
      const hasFiles = Boolean(body.conversationFiles);
      if (!hasLibrary && !hasFiles) {
        json(response, 400, { error: "至少指定 library 或 conversationFiles" });
        return;
      }
      json(response, 200, {
        chunks: queryRetrievalChunks({
          library: body.library,
          conversationFiles: body.conversationFiles,
          withVectors,
        }),
      });
      return;
    }

    // Legacy library-only chunk query (kept for compatibility)
    if (request.method === "POST" && url.pathname === "/knowledge/chunks/query") {
      const body = await readJson(request);
      const mode = body.mode === "all" ? "all" : "documents";
      const withVectors = Boolean(body.withVectors);
      if (mode === "documents") {
        const documentIds = Array.isArray(body.documentIds)
          ? body.documentIds.filter((id) => typeof id === "string")
          : [];
        if (documentIds.length === 0) {
          json(response, 400, { error: "documentIds 不能为空" });
          return;
        }
      }
      json(response, 200, {
        chunks: queryRetrievalChunks({
          library:
            mode === "all"
              ? { mode: "all" }
              : { mode: "documents", documentIds: body.documentIds },
          withVectors,
        }),
      });
      return;
    }

    // Conversation files: list / create
    if (request.method === "GET" && url.pathname === "/conversation-files") {
      recoverStaleEmbeddings();
      const conversationId = String(
        url.searchParams.get("conversationId") || "",
      ).trim();
      if (!conversationId) {
        json(response, 400, { error: "conversationId 不能为空" });
        return;
      }
      json(response, 200, {
        files: listConversationFilesByConversation
          .all(conversationId)
          .map(mapConversationFileRow),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/conversation-files") {
      const conversationId = String(
        request.headers["x-conversation-id"] ||
          url.searchParams.get("conversationId") ||
          "",
      ).trim();
      if (!conversationId) {
        json(response, 400, { error: "conversationId 不能为空" });
        return;
      }
      const contentType = String(request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowed = new Set([
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
      ]);
      if (!allowed.has(contentType)) {
        json(response, 415, {
          error: "目前只支持 PDF、TXT、Markdown（.md）文件",
        });
        return;
      }
      const kindHeader = String(request.headers["x-file-kind"] || "")
        .trim()
        .toLowerCase();
      const kindHint =
        kindHeader === "pdf" || kindHeader === "txt" || kindHeader === "md"
          ? kindHeader
          : contentType === "application/pdf"
            ? "pdf"
            : contentType === "text/markdown" ||
                contentType === "text/x-markdown"
              ? "md"
              : "txt";
      const buffer = await readBuffer(request);
      const name = decodeFileName(request.headers["x-file-name"]);
      try {
        json(response, 201, {
          file: storeConversationFile(buffer, name, kindHint, conversationId),
        });
      } catch (error) {
        if (error?.code === "CONVERSATION_NOT_FOUND") {
          json(response, 404, { error: "对话不存在" });
          return;
        }
        throw error;
      }
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/conversation-files/vectors"
    ) {
      const body = await readJson(request);
      const vectors = body.vectors ?? [];
      if (!Array.isArray(vectors) || vectors.length === 0) {
        json(response, 400, { error: "vectors 数组不能为空" });
        return;
      }
      const byDocument = new Map();
      for (const vec of vectors) {
        if (typeof vec.id !== "string" || !Array.isArray(vec.vector)) {
          json(response, 400, { error: "vector 条目格式无效" });
          return;
        }
        const documentId =
          typeof vec.documentId === "string" ? vec.documentId : "";
        if (!documentId) {
          json(response, 400, { error: "vector 需要 documentId" });
          return;
        }
        const list = byDocument.get(documentId) ?? [];
        list.push(vec);
        byDocument.set(documentId, list);
      }

      for (const [documentId, items] of byDocument) {
        const buildId = indexBuildStore.enqueueVectorBuild({
          namespace: "conversation",
          documentId,
          vectorModel: EMBEDDING_CONFIG.modelName,
          vectorDim: EMBEDDING_CONFIG.dimension,
        });
        indexBuildStore.markBuildRunning(buildId);
        const entries = items.map((item) => ({
          chunkId: item.id,
          embedding: arrayToEmbeddingBlob(item.vector),
        }));
        vectorEntryStore.replaceAll(buildId, entries);
        vectorEntryStore.validateBuild(buildId, {
          expectedCount: entries.length,
          expectedDim: EMBEDDING_CONFIG.dimension,
        });
        indexBuildStore.activateBuild(buildId);
        vectorEntryStore.pruneSupersededVectorBuilds("conversation", documentId);

        database.exec("BEGIN IMMEDIATE");
        try {
          for (const item of items) {
            updateConversationChunkEmbedding.run(
              arrayToEmbeddingBlob(item.vector),
              item.id,
            );
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      json(response, 200, { inserted: vectors.length });
      return;
    }

    // Conversation file scoped routes: /conversation-files/:id/...
    if (parts[0] === "conversation-files" && parts.length >= 2) {
      const fileId = parts[1];
      const action = parts[2];

      if (!action && request.method === "GET") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        json(response, 200, { file: mapConversationFileRow(file) });
        return;
      }

      if (!action && request.method === "DELETE") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          deleteFtsForDocument(database, "conversation", fileId);
          deleteConversationFile.run(fileId);
          database.exec("COMMIT");
          try {
            unlinkSync(file.storedPath);
          } catch {}
          json(response, 200, { deleted: true });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return;
      }

      if (
        action === "bytes" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        if (rejectNonLoopbackBytes(request, response)) return;
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        try {
          sendStoredFileBytes(response, file, {
            headOnly: request.method === "HEAD",
          });
        } catch {
          json(response, 404, { error: "原件文件不存在" });
        }
        return;
      }

      if (action === "chunks" && request.method === "PUT") {
        const body = await readJson(request);
        const pageCount = Number(body.pageCount);
        if (!Number.isFinite(pageCount) || pageCount < 1) {
          json(response, 400, { error: "pageCount 无效" });
          return;
        }
        json(response, 200, {
          file: commitConversationFileChunks(
            fileId,
            pageCount,
            body.chunks ?? [],
          ),
        });
        return;
      }

      if (action === "chunks" && request.method === "GET") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        json(response, 200, {
          chunks: getConversationFileChunks.all(fileId),
          documentName: file.name,
        });
        return;
      }

      if (action === "status" && request.method === "PUT") {
        const body = await readJson(request);
        const allowed = new Set([
          "awaiting_chunks",
          "stored",
          "processing",
          "processing_error",
          "ready",
          "embedding",
          "indexed",
          "error",
        ]);
        if (!allowed.has(body.status)) {
          json(response, 400, { error: "status 无效" });
          return;
        }
        json(response, 200, {
          file: setConversationFileIndexStatus(fileId, body.status, {
            embeddingModel: body.embeddingModel ?? null,
            embeddingDim:
              typeof body.embeddingDim === "number" ? body.embeddingDim : null,
            errorMessage: body.errorMessage ?? null,
          }),
        });
        return;
      }
    }

    // Vector batch upsert（同步 indexer 路径：写入 active/新 build 的 vector_entries）
    if (request.method === "POST" && url.pathname === "/knowledge/vectors") {
      const body = await readJson(request);
      const vectors = body.vectors ?? [];
      if (!Array.isArray(vectors) || vectors.length === 0) {
        json(response, 400, { error: "vectors 数组不能为空" });
        return;
      }
      const byDocument = new Map();
      for (const vec of vectors) {
        if (typeof vec.id !== "string" || !Array.isArray(vec.vector)) {
          json(response, 400, { error: "vector 条目格式无效" });
          return;
        }
        const documentId =
          typeof vec.documentId === "string" ? vec.documentId : "";
        if (!documentId) {
          json(response, 400, { error: "vector 需要 documentId" });
          return;
        }
        const list = byDocument.get(documentId) ?? [];
        list.push(vec);
        byDocument.set(documentId, list);
      }

      for (const [documentId, items] of byDocument) {
        // 同步路径：新建 queued build 写入后立即激活（旧 active 可服务至切换瞬间）
        const buildId = indexBuildStore.enqueueVectorBuild({
          namespace: "library",
          documentId,
          vectorModel: EMBEDDING_CONFIG.modelName,
          vectorDim: EMBEDDING_CONFIG.dimension,
        });
        indexBuildStore.markBuildRunning(buildId);
        const entries = items.map((item) => ({
          chunkId: item.id,
          embedding: arrayToEmbeddingBlob(item.vector),
        }));
        vectorEntryStore.replaceAll(buildId, entries);
        vectorEntryStore.validateBuild(buildId, {
          expectedCount: entries.length,
          expectedDim: EMBEDDING_CONFIG.dimension,
        });
        indexBuildStore.activateBuild(buildId);
        vectorEntryStore.pruneSupersededVectorBuilds("library", documentId);

        // expand dual-write legacy
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const item of items) {
            updateChunkEmbedding.run(
              arrayToEmbeddingBlob(item.vector),
              item.id,
            );
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      json(response, 200, { inserted: vectors.length });
      return;
    }

    // Document-scoped knowledge routes
    if (parts[0] === "knowledge" && parts.length >= 3) {
      const docId = parts[1];
      const action = parts[2];

      // Phase 2: commit chunks from services/knowledge
      if (action === "chunks" && request.method === "PUT") {
        const body = await readJson(request);
        const pageCount = Number(body.pageCount);
        if (!Number.isFinite(pageCount) || pageCount < 1) {
          json(response, 400, { error: "pageCount 无效" });
          return;
        }
        json(response, 200, {
          document: commitKnowledgeChunks(docId, pageCount, body.chunks ?? []),
        });
        return;
      }

      if (action === "chunks" && request.method === "GET") {
        const document = getKnowledgeDocument.get(docId);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        json(response, 200, {
          chunks: getKnowledgeChunks.all(docId),
          documentName: document.name,
        });
        return;
      }

      if (
        action === "bytes" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        if (rejectNonLoopbackBytes(request, response)) return;
        const document = getKnowledgeDocument.get(docId);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        try {
          sendStoredFileBytes(response, document, {
            headOnly: request.method === "HEAD",
          });
        } catch {
          json(response, 404, { error: "原件文件不存在" });
        }
        return;
      }

      if (action === "status" && request.method === "POST") {
        const body = await readJson(request);
        const status = String(body.status || "").trim();
        if (!status) {
          json(response, 400, { error: "status 必填" });
          return;
        }
        try {
          json(response, 200, {
            document: setDocumentIndexStatus(docId, status, {
              errorMessage: body.errorMessage ?? null,
              embeddingModel: body.embeddingModel ?? null,
              embeddingDim: body.embeddingDim ?? null,
            }),
          });
        } catch (error) {
          json(response, 404, {
            error: error instanceof Error ? error.message : "更新失败",
          });
        }
        return;
      }

      if (action === "status" && request.method === "PUT") {
        const body = await readJson(request);
        const allowed = new Set([
          "awaiting_chunks",
          "stored",
          "processing",
          "processing_error",
          "ready",
          "embedding",
          "indexed",
          "error",
        ]);
        if (!allowed.has(body.status)) {
          json(response, 400, { error: "status 无效" });
          return;
        }
        json(response, 200, {
          document: setDocumentIndexStatus(docId, body.status, {
            embeddingModel: body.embeddingModel ?? null,
            embeddingDim:
              typeof body.embeddingDim === "number" ? body.embeddingDim : null,
            errorMessage: body.errorMessage ?? null,
          }),
        });
        return;
      }

      if (action === "reprocess" && request.method === "POST") {
        const document = getKnowledgeDocument.get(docId);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        if (!document.storedPath) {
          json(response, 400, { error: "原件不存在，无法重试" });
          return;
        }
        const settings = readRuntimeSettings();
        if (settings.ocrMode === "disabled") {
          json(response, 422, {
            error: "OCR_DISABLED",
            code: "OCR_DISABLED",
          });
          return;
        }
        setDocumentIndexStatus(docId, "processing", { errorMessage: null });
        const idempotencyKey = `process_revision:library:${docId}`;
        const existing = jobRepository.getByIdempotencyKey(idempotencyKey);
        let job = existing;
        if (existing) {
          job = await prepareReprocessJob(existing, {
            documentId: docId,
            ocrMode: settings.ocrMode,
          });
        } else {
          const payload = await ensureProcessRevisionPayload(
            {
              version: 1,
              namespace: "library",
              documentId: docId,
              ocrMode: settings.ocrMode,
            },
            { ocrMode: settings.ocrMode },
          );
          job = jobRepository.enqueue({
            type: "process_revision",
            idempotencyKey,
            payload,
          });
        }
        json(response, 202, {
          document: mapDocumentRow(getKnowledgeDocument.get(docId)),
          jobId: job?.id,
        });
        return;
      }
    }

    if (parts[0] === "knowledge" && parts.length === 2) {
      const id = parts[1];
      if (request.method === "DELETE") {
        const document = getKnowledgeDocument.get(id);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          deleteFtsForDocument(database, "library", id);
          deleteKnowledgeDocument.run(id);
          database.exec("COMMIT");
          try {
            unlinkSync(document.storedPath);
          } catch {}
          json(response, 200, { deleted: true });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return;
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        try {
          json(response, 200, {
            document: renameKnowledgeDocument(id, body.name),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "重命名失败";
          json(
            response,
            message === "资料不存在" ? 404 : 400,
            { error: message },
          );
        }
        return;
      }

      if (request.method === "GET") {
        const document = getKnowledgeDocument.get(id);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        json(response, 200, { document: mapDocumentRow(document) });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/conversations") {
      const body = await readJson(request);
      json(response, 201, { conversation: saveConversation(body) });
      return;
    }

    if (parts[0] === "conversations" && parts.length === 2) {
      const id = parts[1];
      if (request.method === "GET") {
        const conversation = getConversation.get(id);
        if (!conversation) {
          json(response, 404, { error: "Conversation not found" });
          return;
        }
        json(response, 200, {
          conversation: {
            ...conversation,
            messages: getMessages.all(id).map(mapMessageRow),
          },
        });
        return;
      }

      if (request.method === "PUT") {
        // 禁止用已删 id upsert 复活空壳（与附件上传 requireConversationExists 一致）
        if (!getConversation.get(id)) {
          json(response, 404, { error: "对话不存在" });
          return;
        }
        const body = await readJson(request);
        json(response, 200, {
          conversation: saveConversation(body, id),
        });
        return;
      }

      if (request.method === "DELETE") {
        const conversation = getConversation.get(id);
        if (!conversation) {
          json(response, 404, { deleted: false });
          return;
        }
        const result = deleteConversationWithFiles(id);
        json(response, result.changes ? 200 : 404, {
          deleted: Boolean(result.changes),
        });
        return;
      }
    }

    if (
      request.method === "GET" &&
      parts[0] === "sources" &&
      parts[1] === "by-document" &&
      parts.length === 3
    ) {
      json(response, 200, {
        item: sourcesRepository.getByDocument(parts[2]),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/sources") {
      json(response, 200, { sources: sourcesRepository.list() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/sources/sync") {
      const body = await readJson(request);
      const asyncMode =
        body.async === true || url.searchParams.get("async") === "1";
      try {
        let payload;
        if (body.type === "web" || body.type === "github") {
          payload = { create: body };
        } else if (body.type === "sync" && typeof body.sourceId === "string") {
          payload = { sourceId: body.sourceId, config: body.config };
        } else {
          json(response, 400, { error: "type 必须是 web / github / sync" });
          return;
        }

        const job = jobRepository.enqueue({
          type: "sync_source",
          idempotencyKey: `sync_source:${randomUUID()}`,
          payload,
          maxAttempts: 2,
        });

        if (asyncMode) {
          json(response, 202, { jobId: job.id, job });
          return;
        }

        const done = await waitForJob(job.id, 180_000);
        const result = done.progress?.sync ?? null;
        json(response, 201, { result, job: done });
      } catch (error) {
        json(response, 502, {
          error: error instanceof Error ? error.message : "来源同步失败",
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/sources") {
      const body = await readJson(request);
      const type = body.type;
      if (type !== "web" && type !== "github" && type !== "file") {
        json(response, 400, { error: "type 必须是 web / github / file" });
        return;
      }
      const name = String(body.name || type).slice(0, 180);
      json(response, 201, {
        source: sourcesRepository.create({
          type,
          name,
          config: body.config && typeof body.config === "object" ? body.config : {},
        }),
      });
      return;
    }

    if (parts[0] === "sources" && parts.length >= 2) {
      const sourceId = parts[1];
      const source = sourcesRepository.get(sourceId);

      if (parts.length === 2 && request.method === "GET") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        json(response, 200, { source });
        return;
      }

      if (parts.length === 2 && request.method === "DELETE") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        sourcesRepository.remove(sourceId);
        json(response, 200, { deleted: true });
        return;
      }

      if (parts[2] === "status" && request.method === "PUT") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        const body = await readJson(request);
        json(response, 200, {
          source: sourcesRepository.setStatus(sourceId, {
            status: body.status || "ready",
            checkpoint: body.checkpoint ?? null,
            lastError: body.lastError ?? null,
          }),
        });
        return;
      }

      if (
        parts[2] === "sync-generation" &&
        parts[3] === "begin" &&
        request.method === "POST"
      ) {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        json(response, 200, {
          source: sourcesRepository.beginSyncGeneration(sourceId),
        });
        return;
      }

      if (
        parts[2] === "sync-generation" &&
        parts[3] === "complete" &&
        request.method === "POST"
      ) {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        json(response, 200, {
          source: sourcesRepository.markEnumerationComplete(sourceId),
        });
        return;
      }

      if (
        parts[2] === "items" &&
        parts[3] === "stale" &&
        request.method === "GET"
      ) {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        const generation = Number(url.searchParams.get("generation") || 0);
        json(response, 200, {
          externalIds: sourcesRepository.listStaleExternalIds(
            sourceId,
            generation,
          ),
        });
        return;
      }

      if (parts[2] === "items" && request.method === "GET") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        json(response, 200, { items: sourcesRepository.listItems(sourceId) });
        return;
      }

      if (parts[2] === "item" && request.method === "GET") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        const externalId = String(url.searchParams.get("externalId") || "");
        if (!externalId) {
          json(response, 400, { error: "externalId 不能为空" });
          return;
        }
        json(response, 200, {
          item: sourcesRepository.getItem(sourceId, externalId),
        });
        return;
      }

      if (parts[2] === "items" && request.method === "PUT") {
        if (!source) {
          json(response, 404, { error: "来源不存在" });
          return;
        }
        const body = await readJson(request);
        if (!body.externalId || typeof body.externalId !== "string") {
          json(response, 400, { error: "externalId 必填" });
          return;
        }
        json(response, 200, {
          item: sourcesRepository.upsertItem(sourceId, body),
        });
        return;
      }
    }

    if (request.method === "DELETE" && url.pathname === "/conversations") {
      clearAllConversations();
      json(response, 200, { deleted: true });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
  } finally {
    currentHttpRequest = null;
  }
});

server.listen(port, host, () => {
  console.log(`Orynode local data service: http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
  console.log(`Index worker: ${indexWorker.workerId}`);
});

function shutdown() {
  indexWorker.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
