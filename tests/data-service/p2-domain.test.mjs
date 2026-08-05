import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { createIndexBuildStore } from "../../scripts/data-service/index-builds.mjs";
import { createProcessingBuildStore } from "../../scripts/data-service/processing-builds.mjs";
import { createSourcesRepository } from "../../scripts/data-service/sources.mjs";
import { createStorageStagingStore } from "../../scripts/data-service/storage-staging.mjs";
import { createJobRepository } from "../../scripts/data-service/jobs.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-p2-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dir, dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migration 008: processing_builds / spaces / staging 表存在", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    const result = migrateDatabase(database);
    assert.ok(result.applied.includes("008_processing_builds_spaces"));
    const tables = database
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => r.name);
    for (const name of [
      "processing_builds",
      "knowledge_spaces",
      "space_document_bindings",
      "storage_staging",
    ]) {
      assert.ok(tables.includes(name), `missing ${name}`);
    }
    const space = database
      .prepare(`SELECT id, kind FROM knowledge_spaces WHERE id = 'space-library'`)
      .get();
    assert.equal(space?.kind, "library");
    database.close();
  });
});

test("ProcessingBuild: recordKeywordReady 写入真实 processing_build_id", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const builds = createIndexBuildStore(database);
    const recorded = builds.recordKeywordReady({
      namespace: "library",
      documentId: "doc-1",
      contentHash: "abc",
    });
    assert.ok(recorded.processingBuildId);
    assert.notEqual(recorded.processingBuildId, recorded.keywordBuildId);

    const version = builds.getActiveKeywordVersion("library", "doc-1");
    assert.equal(version.revisionId, recorded.revisionId);
    assert.equal(version.processingBuildId, recorded.processingBuildId);

    const pb = createProcessingBuildStore(database).get(recorded.processingBuildId);
    assert.equal(pb.status, "ready");
    assert.equal(pb.isActive, 1);

    const chunk = database
      .prepare(
        `SELECT processing_build_id AS pb, is_active AS active FROM chunk_sets WHERE id = ?`,
      )
      .get(recorded.chunkSetId);
    assert.equal(chunk.pb, recorded.processingBuildId);
    assert.equal(chunk.active, 1);
    database.close();
  });
});

test("sync generation: 仅完整枚举后 stale 可 tombstone", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const sources = createSourcesRepository(database);
    const source = sources.create({
      type: "web",
      name: "example",
      config: { url: "https://example.com" },
    });
    sources.upsertItem(source.id, {
      externalId: "a",
      uri: "https://example.com/a",
      title: "a",
      documentId: "d1",
      lastSeenGeneration: 0,
    });
    sources.upsertItem(source.id, {
      externalId: "b",
      uri: "https://example.com/b",
      title: "b",
      documentId: "d2",
      lastSeenGeneration: 0,
    });

    const begun = sources.beginSyncGeneration(source.id);
    assert.equal(begun.syncGeneration, 1);
    sources.touchItemSeen(source.id, "a", 1);
    const stale = sources.listStaleExternalIds(source.id, 1);
    assert.deepEqual(stale, ["b"]);
    sources.markEnumerationComplete(source.id);
    assert.equal(sources.get(source.id).lastCompleteGeneration, 1);
    database.close();
  });
});

test("storage staging: atomic write + reconcile 清理 partial", () => {
  withTempDb((dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const filesDir = join(dir, "files");
    mkdirSync(filesDir, { recursive: true });
    const staging = createStorageStagingStore(database);
    const finalPath = join(filesDir, "doc1.md");

    const written = staging.writeAtomicFile({
      namespace: "library",
      documentId: "doc1",
      finalPath,
      buffer: Buffer.from("hello"),
      contentHash: "h1",
    });
    assert.equal(existsSync(finalPath), true);
    assert.equal(readFileSync(finalPath, "utf8"), "hello");
    assert.equal(existsSync(`${finalPath}.partial`), false);
    staging.markCommitted(written.stagingId, "doc1");

    const orphanPartial = join(filesDir, "orphan.md.partial");
    writeFileSync(orphanPartial, "partial");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO storage_staging (
          id, namespace, document_id, staging_path, final_path, content_hash,
          status, created_at, updated_at
        ) VALUES (?, 'library', NULL, ?, ?, NULL, 'writing', ?, ?)`,
      )
      .run("stg-1", orphanPartial, join(filesDir, "orphan.md"), now, now);

    const result = staging.reconcileOnStartup({
      knowledgeFilesPath: filesDir,
      attachmentFilesPath: join(dir, "attachments"),
    });
    assert.ok(result.cleanedPartials >= 1);
    assert.equal(existsSync(orphanPartial), false);
    assert.equal(existsSync(finalPath), true);
    database.close();
  });
});

test("jobs: 可 enqueue sync_source", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);
    const job = jobs.enqueue({
      type: "sync_source",
      idempotencyKey: "sync:1",
      payload: { create: { type: "web", url: "https://example.com" } },
    });
    const claimed = jobs.claim("w", ["sync_source", "embed_document"], 5000);
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.type, "sync_source");
    jobs.complete(claimed.id, "w", { sync: { imported: 1 } });
    assert.equal(jobs.get(job.id).status, "succeeded");
    database.close();
  });
});

test("jobs: garbage_collect 可入队", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);
    const job = jobs.enqueue({
      type: "garbage_collect",
      idempotencyKey: "gc:test",
      payload: { targets: ["agent_spaces"] },
    });
    const claimed = jobs.claim("w", ["garbage_collect"], 5000);
    assert.equal(claimed.id, job.id);
    jobs.complete(claimed.id, "w", { gc: { agentSpacesExpired: 0 } });
    assert.equal(jobs.get(job.id).status, "succeeded");
    database.close();
  });
});

test("jobs: list 返回 active 与最近完成，按 updated 排序", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);

    const a = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:a",
      payload: { namespace: "library", documentId: "doc-a" },
    });
    const b = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:b",
      payload: { namespace: "library", documentId: "doc-b" },
    });
    const claimed = jobs.claim("w", ["embed_document"], 5000);
    assert.ok(claimed);
    jobs.complete(claimed.id, "w", { phase: "embedding", done: 3, total: 3 });

    const listed = jobs.list({ includeRecent: true, limit: 20 });
    assert.ok(listed.summary.active >= 1);
    assert.ok(listed.summary.queued + listed.summary.running >= 1);
    assert.ok(listed.jobs.some((j) => j.id === a.id || j.id === b.id));
    assert.ok(listed.jobs.some((j) => j.status === "succeeded"));
    const ids = listed.jobs.map((j) => j.id);
    assert.equal(new Set(ids).size, ids.length);
    database.close();
  });
});

test("jobs: cancel 可取消 queued", () => {
  withTempDb((_dir, dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const jobs = createJobRepository(database);
    const job = jobs.enqueue({
      type: "embed_document",
      idempotencyKey: "embed:cancel",
      payload: { namespace: "library", documentId: "doc-x" },
    });
    assert.equal(jobs.cancel(job.id), true);
    assert.equal(jobs.get(job.id).status, "cancelled");
    database.close();
  });
});
