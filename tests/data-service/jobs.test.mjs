import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createJobRepository } from "../../scripts/data-service/jobs.mjs";
import { createIndexBuildStore } from "../../scripts/data-service/index-builds.mjs";
import { createResourceCoordinator } from "../../scripts/data-service/resource-coordinator.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-jobs-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("jobs: enqueue 幂等 + claim/complete/fail 重试", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);

    const a = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:doc-1",
      payload: { documentId: "doc-1" },
      maxAttempts: 2,
    });
    const b = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:doc-1",
      payload: { documentId: "doc-1" },
    });
    assert.equal(a.id, b.id);

    const claimed = jobs.claim("worker-1", ["embed_document"], 5000);
    assert.equal(claimed.id, a.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempts, 1);

    jobs.fail(claimed.id, "worker-1", "boom", 0);
    const afterFail = jobs.get(claimed.id);
    assert.equal(afterFail.status, "retry_wait");

    const claimed2 = jobs.claim("worker-1", ["embed_document"], 5000);
    assert.equal(claimed2.id, a.id);
    jobs.complete(claimed2.id, "worker-1", { ok: true });
    assert.equal(jobs.get(a.id).status, "succeeded");
    database.close();
  });
});

test("jobs: defer 不消耗 attempts", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);
    const job = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:defer",
      payload: {},
      maxAttempts: 3,
    });
    const claimed = jobs.claim("w", ["embed_document"], 5000);
    assert.equal(claimed.attempts, 1);
    assert.equal(jobs.defer(claimed.id, "w", 0), true);
    const again = jobs.claim("w", ["embed_document"], 5000);
    assert.equal(again.id, job.id);
    assert.equal(again.attempts, 1);
    database.close();
  });
});

test("index builds: 原子切换 active + 失败保留旧版", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const store = createIndexBuildStore(database);

    const first = store.recordKeywordReady({
      namespace: "library",
      documentId: "d1",
      contentHash: "hash-1",
      enqueueVector: true,
      vectorModel: "bge",
      vectorDim: 512,
    });
    assert.ok(first.vectorBuildId);
    store.markBuildRunning(first.vectorBuildId);
    store.activateBuild(first.vectorBuildId);
    assert.equal(
      store.getActiveBuild("library", "d1", "vector")?.id,
      first.vectorBuildId,
    );

    const second = store.recordKeywordReady({
      namespace: "library",
      documentId: "d1",
      contentHash: "hash-1",
      enqueueVector: true,
      vectorModel: "bge",
      vectorDim: 512,
    });
    store.markBuildRunning(second.vectorBuildId);
    store.markBuildFailed(second.vectorBuildId, "oom");
    // 失败未 activate → 旧 active 仍在
    assert.equal(
      store.getActiveBuild("library", "d1", "vector")?.id,
      first.vectorBuildId,
    );

    store.activateBuild(second.vectorBuildId);
    assert.equal(
      store.getActiveBuild("library", "d1", "vector")?.id,
      second.vectorBuildId,
    );
    assert.equal(store.getBuild(first.vectorBuildId).status, "superseded");
    database.close();
  });
});

test("jobs: mergePayload 保留 processingBuildId，重试可读同一 checkpoint", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);

    const job = jobs.enqueue({
      type: "process_revision",
      idempotencyKey: "process_revision:library:doc-retry",
      payload: {
        version: 1,
        namespace: "library",
        documentId: "doc-retry",
        ocrMode: "auto",
      },
      maxAttempts: 3,
    });

    const claimed = jobs.claim("worker-1", ["process_revision"], 5000);
    assert.equal(claimed.id, job.id);

    // 模拟 Worker：首次运行时写入完整 V1 payload
    jobs.mergePayload(job.id, {
      revisionId: "rev-fixed",
      processingBuildId: "pb-fixed",
    });

    jobs.fail(job.id, "worker-1", "OCR_TIMEOUT", 0);
    const waiting = jobs.get(job.id);
    assert.equal(waiting.status, "retry_wait");
    assert.equal(waiting.payload.processingBuildId, "pb-fixed");
    assert.equal(waiting.payload.revisionId, "rev-fixed");

    const claimed2 = jobs.claim("worker-1", ["process_revision"], 5000);
    assert.equal(claimed2.payload.processingBuildId, "pb-fixed");
    assert.equal(claimed2.attempts, 2);
    jobs.complete(claimed2.id, "worker-1", { ok: true });
    database.close();
  });
});

test("resource coordinator: chat 优先阻塞 embedding", () => {
  const resources = createResourceCoordinator();
  const token = resources.markChatActive(10_000);
  assert.equal(resources.shouldDeferHeavyWork(), true);
  assert.equal(
    resources.tryAcquire({ kind: "embedding", owner: "w" }).ok,
    false,
  );
  resources.markChatIdle(token);
  assert.equal(resources.shouldDeferHeavyWork(), false);
  const acquired = resources.tryAcquire({ kind: "embedding", owner: "w" });
  assert.equal(acquired.ok, true);
  assert.equal(resources.release("wrong-lease"), false);
  assert.equal(resources.release(acquired.leaseId), true);
});

test("resource coordinator: 并发 Chat 引用计数", () => {
  const resources = createResourceCoordinator();
  const a = resources.markChatActive(10_000);
  const b = resources.markChatActive(10_000);
  resources.markChatIdle(a);
  assert.equal(resources.shouldDeferHeavyWork(), true);
  resources.markChatIdle(b);
  assert.equal(resources.shouldDeferHeavyWork(), false);
});

test("resource coordinator: 同一 owner 不可重入", () => {
  const resources = createResourceCoordinator();
  const first = resources.tryAcquire({ kind: "embedding", owner: "w" });
  assert.equal(first.ok, true);
  assert.equal(
    resources.tryAcquire({ kind: "embedding", owner: "w" }).ok,
    false,
  );
  resources.release(first.leaseId);
});
