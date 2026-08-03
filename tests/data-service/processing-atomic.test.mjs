/**
 * ProcessingBuild 原子激活 + bboxDegraded 检索集成
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createIndexBuildStore } from "../../scripts/data-service/index-builds.mjs";
import { createProcessingBuildStore } from "../../scripts/data-service/processing-builds.mjs";
import { createDocumentBlockStore } from "../../scripts/data-service/document-blocks.mjs";
import { createJobRepository } from "../../scripts/data-service/jobs.mjs";
import {
  searchKeywordIndex,
  upsertFtsChunks,
} from "../../scripts/data-service/fts-index.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-atomic-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("recordKeywordReady 故障注入：激活后失败则整事务回滚，旧 active 保留", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const processing = createProcessingBuildStore(database);

    const first = builds.recordKeywordReady({
      namespace: "library",
      documentId: "doc-a",
      contentHash: "hash-a",
    });
    const oldActive = processing.get(first.processingBuildId);
    assert.equal(oldActive.isActive, 1);
    assert.equal(oldActive.status, "ready");

    const pending = processing.beginBuild({
      revisionId: first.revisionId,
      configHash: "pending-v2",
    });
    assert.equal(pending.isActive, 0);

    assert.throws(
      () =>
        builds.recordKeywordReady({
          namespace: "library",
          documentId: "doc-a",
          contentHash: "hash-a",
          processingBuildId: pending.id,
          activateProcessing: true,
          __failAfterProcessingActivate: true,
        }),
      /TEST_FAIL_AFTER_PROCESSING_ACTIVATE/,
    );

    const oldAfter = processing.get(first.processingBuildId);
    const pendingAfter = processing.get(pending.id);
    assert.equal(oldAfter.isActive, 1);
    assert.equal(oldAfter.status, "ready");
    assert.equal(pendingAfter.isActive, 0);
    assert.notEqual(pendingAfter.status, "ready");
    database.close();
  });
});

test("markFailed 不得回退已激活 ready ProcessingBuild", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const processing = createProcessingBuildStore(database);

    const first = builds.recordKeywordReady({
      namespace: "library",
      documentId: "doc-b",
      contentHash: "hash-b",
    });
    const after = processing.markFailed(first.processingBuildId, "late-error");
    assert.equal(after.isActive, 1);
    assert.equal(after.status, "ready");
    database.close();
  });
});

test("succeeded reprocess 语义：forceNewBuild 不复用 active build id", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const processing = createProcessingBuildStore(database);
    const jobs = createJobRepository(database);

    const first = builds.recordKeywordReady({
      namespace: "library",
      documentId: "doc-c",
      contentHash: "hash-c",
    });
    const job = jobs.enqueue({
      type: "process_revision",
      idempotencyKey: "process_revision:library:doc-c",
      payload: {
        version: 1,
        namespace: "library",
        documentId: "doc-c",
        revisionId: first.revisionId,
        processingBuildId: first.processingBuildId,
        ocrMode: "auto",
      },
    });
    const claimed = jobs.claim("w", ["process_revision"], 5000);
    jobs.complete(claimed.id, "w", { ok: true });
    assert.equal(jobs.get(job.id).status, "succeeded");

    // 模拟 ensureProcessRevisionPayload(forceNewBuild)：active ready 不可复用
    const existingBuild = processing.get(first.processingBuildId);
    assert.equal(existingBuild.isActive, 1);
    const fresh = processing.beginBuild({
      revisionId: first.revisionId,
      configHash: "reprocess-v2",
    });
    assert.notEqual(fresh.id, first.processingBuildId);
    assert.equal(fresh.isActive, 0);
    assert.equal(processing.get(first.processingBuildId).status, "ready");
    assert.equal(processing.get(first.processingBuildId).isActive, 1);

    jobs.mergePayload(job.id, { processingBuildId: fresh.id });
    jobs.requeueFromTerminal(job.id);
    assert.equal(jobs.get(job.id).payload.processingBuildId, fresh.id);
    assert.equal(jobs.get(job.id).status, "queued");
    database.close();
  });
});

test("FTS: 完全不匹配 / 部分匹配 bboxDegraded 仅 page locator", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const blocks = createDocumentBlockStore(database);
    const processing = createProcessingBuildStore(database);
    const builds = createIndexBuildStore(database);

    const versioning = builds.recordKeywordReady({
      namespace: "library",
      documentId: "doc-bbox",
      contentHash: "hash-bbox",
    });
    const buildId = versioning.processingBuildId;

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-bbox", "scan.pdf", "/tmp/s.pdf", 10, 1, 2, now, "ready");

    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("chunk-none", "doc-bbox", 1, 0, "完全不匹配的检索正文一二三四五");
    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "chunk-partial",
        "doc-bbox",
        1,
        1,
        "标题甲 以及正文段落内容很长用于匹配",
      );

    upsertFtsChunks(database, "library", "doc-bbox", [
      { id: "chunk-none", content: "完全不匹配的检索正文一二三四五" },
      {
        id: "chunk-partial",
        content: "标题甲 以及正文段落内容很长用于匹配",
      },
    ]);

    blocks.replaceBlocksForBuild(buildId, [
      {
        id: "b1",
        pageNumber: 1,
        readingOrder: 0,
        text: "标题甲",
        origin: "ocr",
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      },
      {
        id: "b2",
        pageNumber: 1,
        readingOrder: 1,
        text: "正文段落内容很长用于匹配",
        origin: "ocr",
        bbox: { x: 0.1, y: 0.3, width: 0.5, height: 0.1 },
      },
    ]);

    // 完全不匹配：无 refs，locator.bbox_degraded=1
    blocks.replaceChunkLocatorsBatch("library", [
      { chunkId: "chunk-none", pageNumber: 1, bboxDegraded: true },
      // 部分匹配：相关块未全部精确映射 → degraded，不写 refs
      { chunkId: "chunk-partial", pageNumber: 1, bboxDegraded: true },
    ]);

    const noneHit = searchKeywordIndex(database, {
      query: "完全不匹配",
      library: { mode: "documents", documentIds: ["doc-bbox"] },
      topK: 5,
    });
    const none = noneHit.chunks.find((c) => c.id === "chunk-none");
    assert.ok(none);
    assert.equal(none.bboxDegraded, true);
    assert.equal(none.locatorHint?.kind, "page");
    assert.equal(none.bbox, undefined);

    const partialHit = searchKeywordIndex(database, {
      query: "正文段落",
      library: { mode: "documents", documentIds: ["doc-bbox"] },
      topK: 5,
    });
    const partial = partialHit.chunks.find((c) => c.id === "chunk-partial");
    assert.ok(partial);
    assert.equal(partial.bboxDegraded, true);
    assert.equal(partial.locatorHint?.kind, "page");
    assert.equal(partial.bbox, undefined);

    // 完整映射对照：bbox 应出现
    blocks.replaceChunkLocatorsBatch("library", [
      { chunkId: "chunk-partial", pageNumber: 1, bboxDegraded: false },
    ]);
    blocks.replaceChunkBlockRefsBatch("library", [
      {
        chunkId: "chunk-partial",
        refs: [
          { blockId: "b1", startOffset: 0, endOffset: 3 },
          { blockId: "b2", startOffset: 5, endOffset: 18 },
        ],
      },
    ]);
    const fullHit = searchKeywordIndex(database, {
      query: "正文段落",
      library: { mode: "documents", documentIds: ["doc-bbox"] },
      topK: 5,
    });
    const full = fullHit.chunks.find((c) => c.id === "chunk-partial");
    assert.ok(full);
    assert.equal(full.bboxDegraded, undefined);
    assert.ok(Array.isArray(full.bbox) || full.locatorHint?.bbox);
    database.close();
  });
});
