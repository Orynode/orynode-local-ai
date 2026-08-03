import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createIndexBuildStore } from "../../scripts/data-service/index-builds.mjs";
import { createVectorEntryStore } from "../../scripts/data-service/vector-entries.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-vec-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function floatBlob(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

test("vector_entries: 迁移建表 + legacy embedding 回填", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    const now = new Date().toISOString();
    // 手动建 baseline 表后写入 embedding，再跑全量 migrate 会应用 007 backfill
    // 这里直接 migrate 空库，再手工模拟「仅有 legacy embedding」场景：
    migrateDatabase(database);

    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-legacy", "old.md", "/tmp/old.md", 1, 1, 1, now, "indexed");

    const chunkId = "c-legacy";
    const blob = floatBlob([0.1, 0.2, 0.3, 0.4]);
    // 补齐到 512 维会太大；backfill 用实际长度。先写短向量仅测表与写入路径。
    database
      .prepare(
        `INSERT INTO knowledge_chunks
          (id, document_id, page_number, position, content, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chunkId, "d-legacy", 1, 0, "hello", blob);

    // 手动调用 backfill 逻辑：enqueue build + entries
    const builds = createIndexBuildStore(database);
    const entries = createVectorEntryStore(database);
    const buildId = builds.enqueueVectorBuild({
      namespace: "library",
      documentId: "d-legacy",
      vectorModel: "test",
      vectorDim: 4,
    });
    entries.replaceAll(buildId, [{ chunkId, embedding: blob }]);
    entries.validateBuild(buildId, { expectedCount: 1, expectedDim: 4 });
    builds.activateBuild(buildId);

    const active = builds.getActiveBuild("library", "d-legacy", "vector");
    assert.equal(active.id, buildId);
    assert.equal(entries.count(buildId), 1);
    database.close();
  });
});

test("vector_entries: 双建期间旧 active 不变；激活后切换", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const entries = createVectorEntryStore(database);
    const now = new Date().toISOString();

    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d1", "a.md", "/tmp/a.md", 1, 1, 1, now, "indexed");
    database
      .prepare(
        `INSERT INTO knowledge_chunks
          (id, document_id, page_number, position, content, embedding)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("c1", "d1", 1, 0, "text", floatBlob([1, 0, 0, 0]));

    const buildA = builds.enqueueVectorBuild({
      namespace: "library",
      documentId: "d1",
      vectorModel: "m",
      vectorDim: 4,
    });
    entries.replaceAll(buildA, [
      { chunkId: "c1", embedding: floatBlob([1, 0, 0, 0]) },
    ]);
    builds.activateBuild(buildA);

    const buildB = builds.enqueueVectorBuild({
      namespace: "library",
      documentId: "d1",
      vectorModel: "m",
      vectorDim: 4,
    });
    // 构建 B 期间 A 仍 active
    assert.equal(builds.getActiveBuild("library", "d1", "vector").id, buildA);
    entries.replaceAll(buildB, [
      { chunkId: "c1", embedding: floatBlob([0, 1, 0, 0]) },
    ]);
    assert.equal(builds.getActiveBuild("library", "d1", "vector").id, buildA);

    builds.activateBuild(buildB);
    assert.equal(builds.getActiveBuild("library", "d1", "vector").id, buildB);
    assert.equal(builds.getBuild(buildA).status, "superseded");

    // 回滚
    const rolled = entries.rollbackToPrevious("library", "d1", builds);
    assert.equal(rolled.id, buildA);
    assert.equal(builds.getActiveBuild("library", "d1", "vector").id, buildA);

    database.close();
  });
});

test("vector_entries: 校验失败不激活；失败 build 可删 entries", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const entries = createVectorEntryStore(database);

    const buildId = builds.enqueueVectorBuild({
      namespace: "library",
      documentId: "dx",
      vectorModel: "m",
      vectorDim: 4,
    });
    entries.replaceAll(buildId, [
      { chunkId: "c", embedding: floatBlob([1, 2, 3, 4]) },
    ]);
    assert.throws(
      () =>
        entries.validateBuild(buildId, {
          expectedCount: 2,
          expectedDim: 4,
        }),
      /数量不匹配/,
    );
    builds.markBuildFailed(buildId, "validate failed");
    assert.equal(builds.getActiveBuild("library", "dx", "vector"), null);
    entries.deleteForBuild(buildId);
    assert.equal(entries.count(buildId), 0);
    database.close();
  });
});

test("migrateDatabase 含 007_vector_entries", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    const result = migrateDatabase(database);
    assert.ok(result.applied.includes("007_vector_entries"));
    const table = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='vector_entries'`,
      )
      .get();
    assert.ok(table);
    database.close();
  });
});
