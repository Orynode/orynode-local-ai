/**
 * 本机 Index / Sync Worker（与 data-service 同进程，Phase 2 + KE-P2-02）
 *
 * Job types:
 * - embed_document：写向量 → 激活 IndexBuild
 * - sync_source：Connector 同步（discover/fetch/ingest）
 *
 * - tick 串行：running guard，禁止 setInterval 重叠
 * - 每 attempt 唯一 leaseId
 */

import { EMBEDDING_CONFIG } from "./embed-config.mjs";

const WORKER_ID = `data-service-worker-${process.pid}`;
const LEASE_MS = 60_000;
const POLL_MS = 1500;
const JOB_TYPES = [
  "embed_document",
  "sync_source",
  "garbage_collect",
  "process_revision",
];

/**
 * @param {object} deps
 */
export function startIndexWorker(deps) {
  const {
    jobs,
    indexBuilds,
    vectorEntries = null,
    resources,
    embedEnabled,
    embedTexts,
    writeVectors,
    setDocumentStatus,
    runSyncSource = null,
    runGarbageCollect = null,
    runProcessRevision = null,
    log = console,
  } = deps;

  let stopped = false;
  let timer = null;
  let tickRunning = false;

  async function processEmbedJob(job) {
    const payload = job.payload ?? {};
    const namespace = payload.namespace === "conversation" ? "conversation" : "library";
    const documentId = String(payload.documentId || "");
    let buildId = typeof payload.indexBuildId === "string" ? payload.indexBuildId : null;
    if (!documentId) {
      throw new Error("embed_document 缺少 documentId");
    }

    if (!buildId) {
      buildId = indexBuilds.enqueueVectorBuild({
        namespace,
        documentId,
        vectorModel: EMBEDDING_CONFIG.modelName,
        vectorDim: EMBEDDING_CONFIG.dimension,
      });
    }

    const acquire = resources.tryAcquire({
      kind: "embedding",
      owner: WORKER_ID,
      attemptId: `${job.id}:${job.attempts ?? 0}`,
    });
    if (!acquire.ok) {
      jobs.defer(job.id, WORKER_ID, 3000);
      return { deferred: true, reason: acquire.reason };
    }

    const leaseId = acquire.leaseId;
    try {
      if (!embedEnabled()) {
        if (buildId) {
          indexBuilds.markBuildFailed(buildId, "semantic search disabled");
        }
        await setDocumentStatus(namespace, documentId, "ready", {
          errorMessage: null,
        });
        return { skipped: true, reason: "semantic_disabled" };
      }

      if (buildId) {
        indexBuilds.markBuildRunning(buildId);
      }
      await setDocumentStatus(namespace, documentId, "embedding", {});
      jobs.setProgress(job.id, WORKER_ID, { phase: "embedding", documentId });

      const result = await writeVectors({
        namespace,
        documentId,
        indexBuildId: buildId,
        embedTexts,
        onProgress: (progress) => {
          jobs.setProgress(job.id, WORKER_ID, progress);
          jobs.heartbeat(job.id, WORKER_ID, LEASE_MS);
        },
      });

      if (buildId) {
        indexBuilds.activateBuild(buildId);
        if (typeof vectorEntries?.pruneSupersededVectorBuilds === "function") {
          vectorEntries.pruneSupersededVectorBuilds(namespace, documentId);
        }
      }
      await setDocumentStatus(namespace, documentId, "indexed", {
        embeddingModel: result.model || EMBEDDING_CONFIG.modelName,
        embeddingDim: result.dimension || EMBEDDING_CONFIG.dimension,
        errorMessage: null,
      });
      return { indexed: true, chunkCount: result.chunkCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (buildId) {
        indexBuilds.markBuildFailed(buildId, message);
        const previous = indexBuilds.getActiveBuild(
          namespace,
          documentId,
          "vector",
        );
        if (previous) {
          await setDocumentStatus(namespace, documentId, "indexed", {
            embeddingModel: previous.model,
            embeddingDim: previous.dimension,
            errorMessage: `新索引失败，仍使用上一版: ${message}`,
          });
        } else {
          await setDocumentStatus(namespace, documentId, "error", {
            errorMessage: message,
          });
        }
      } else {
        await setDocumentStatus(namespace, documentId, "error", {
          errorMessage: message,
        });
      }
      throw error;
    } finally {
      resources.release(leaseId);
    }
  }

  async function processSyncSourceJob(job) {
    if (typeof runSyncSource !== "function") {
      throw new Error("sync_source handler 未注入");
    }
    const payload = job.payload ?? {};
    const sourceId = String(payload.sourceId || "");
    if (!sourceId && !payload.create) {
      throw new Error("sync_source 缺少 sourceId 或 create");
    }

    jobs.setProgress(job.id, WORKER_ID, {
      phase: "syncing",
      sourceId: sourceId || null,
    });
    const heartbeat = setInterval(() => {
      try {
        jobs.heartbeat(job.id, WORKER_ID, LEASE_MS);
      } catch {
        // ignore
      }
    }, Math.floor(LEASE_MS / 3));
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    try {
      const result = await runSyncSource(payload, {
        onProgress: (progress) => {
          jobs.setProgress(job.id, WORKER_ID, progress);
          jobs.heartbeat(job.id, WORKER_ID, LEASE_MS);
        },
      });
      return { sync: result };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function processGarbageCollectJob(job) {
    if (typeof runGarbageCollect !== "function") {
      throw new Error("garbage_collect handler 未注入");
    }
    jobs.setProgress(job.id, WORKER_ID, { phase: "gc" });
    const result = await runGarbageCollect(job.payload ?? {});
    return { gc: result };
  }

  async function processRevisionJob(job) {
    if (typeof runProcessRevision !== "function") {
      throw new Error("process_revision handler 未注入");
    }
    jobs.setProgress(job.id, WORKER_ID, { phase: "analyzing" });
    const heartbeat = setInterval(() => {
      try {
        jobs.heartbeat(job.id, WORKER_ID, LEASE_MS);
      } catch {
        // ignore
      }
    }, Math.floor(LEASE_MS / 3));
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    try {
      const result = await runProcessRevision(job.payload ?? {}, {
        jobId: job.id,
        onProgress: (progress) => {
          jobs.setProgress(job.id, WORKER_ID, progress);
          jobs.heartbeat(job.id, WORKER_ID, LEASE_MS);
        },
        deferIfBusy: true,
      });
      if (result?.deferred) {
        jobs.defer(job.id, WORKER_ID, 3000);
        return { deferred: true, reason: result.reason };
      }
      return { processRevision: result };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function tick() {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      if (resources.shouldDeferHeavyWork()) {
        return;
      }
      const job = jobs.claim(WORKER_ID, JOB_TYPES, LEASE_MS);
      if (!job) return;

      try {
        let progress;
        if (job.type === "sync_source") {
          progress = await processSyncSourceJob(job);
        } else if (job.type === "garbage_collect") {
          progress = await processGarbageCollectJob(job);
        } else if (job.type === "process_revision") {
          progress = await processRevisionJob(job);
        } else {
          progress = await processEmbedJob(job);
        }
        if (progress?.deferred) {
          return;
        }
        jobs.complete(job.id, WORKER_ID, progress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (String(message).startsWith("OCR_LEASE_BUSY")) {
          jobs.defer(job.id, WORKER_ID, 3000);
          return;
        }
        jobs.fail(job.id, WORKER_ID, message, 8000);
        log.warn?.(`[worker] job ${job.id} failed: ${message}`);
      }
    } catch (error) {
      log.warn?.(
        `[worker] tick error: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      tickRunning = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(() => {
        scheduleNext();
      });
    }, POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  void tick().finally(() => {
    scheduleNext();
  });

  return {
    workerId: WORKER_ID,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
