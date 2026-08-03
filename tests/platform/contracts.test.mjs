/**
 * 跨平台契约：路径 / 文件名 / Windows Host Profile stub
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  toStorageKey,
  sanitizeFileName,
  looksLikeWindowsAbsolutePath,
  assertRelativeStorageKey,
  createWindowsHostRuntime,
  createHostRuntime,
} from "../../services/platform/index.ts";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import { exportKnowledgePackage } from "../../scripts/data-service/export-package.mjs";

test("toStorageKey: 剥离 Windows 盘符与反斜杠", () => {
  assert.equal(toStorageKey("C:\\\\Users\\\\me\\\\a.md"), "Users/me/a.md");
  assert.equal(toStorageKey("/Users/me/a.md"), "Users/me/a.md");
  assert.equal(toStorageKey("files/../x"), "files/x");
});

test("sanitizeFileName: Windows 保留名与危险字符", () => {
  assert.equal(sanitizeFileName("CON.md"), "_CON.md");
  assert.equal(sanitizeFileName("nul"), "_nul");
  assert.match(sanitizeFileName('a<b>|c?.txt'), /_/);
});

test("assertRelativeStorageKey: 拒绝绝对路径", () => {
  assert.throws(() => assertRelativeStorageKey("/abs/x"), /相对/);
  assert.throws(
    () => assertRelativeStorageKey("C:\\\\temp\\\\x"),
    /相对/,
  );
  assert.doesNotThrow(() => assertRelativeStorageKey("files/a.md"));
});

test("looksLikeWindowsAbsolutePath", () => {
  assert.equal(looksLikeWindowsAbsolutePath("C:\\\\data\\\\x"), true);
  assert.equal(looksLikeWindowsAbsolutePath("files/x"), false);
});

test("Windows Host Profile stub: 诚实 capability", async () => {
  const runtime = createWindowsHostRuntime("/tmp/orynode-win-test");
  assert.equal(runtime.platform, "windows");
  const caps = await runtime.capabilities();
  assert.equal(caps.modelRuntime, false);
  assert.equal(caps.memoryTier, "lite");
  assert.ok(runtime.paths().database.includes("orynode.db"));
});

test("createHostRuntime: ORYNODE_HOST_PLATFORM=windows", async () => {
  const prev = process.env.ORYNODE_HOST_PLATFORM;
  process.env.ORYNODE_HOST_PLATFORM = "windows";
  try {
    const runtime = createHostRuntime("/tmp/project");
    assert.equal(runtime.platform, "windows");
  } finally {
    if (prev === undefined) delete process.env.ORYNODE_HOST_PLATFORM;
    else process.env.ORYNODE_HOST_PLATFORM = prev;
  }
});

test("schema contract: migrations 001–012 表存在", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-schema-"));
  const dbPath = join(dir, "t.db");
  try {
    const database = new DatabaseSync(dbPath);
    const result = migrateDatabase(database);
    assert.ok(result.applied.includes("001_baseline"));
    assert.ok(result.applied.includes("005_sources_connectors"));
    assert.ok(result.applied.includes("006_source_search_visibility"));
    assert.ok(result.applied.includes("007_vector_entries"));
    assert.ok(result.applied.includes("008_processing_builds_spaces"));
    assert.ok(result.applied.includes("009_agent_spaces"));
    assert.ok(result.applied.includes("010_ocr_document_blocks"));
    assert.ok(result.applied.includes("011_processing_build_pages"));
    assert.ok(result.applied.includes("012_chunk_locators"));
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='document_blocks'",
        )
        .get(),
    );
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_block_refs'",
        )
        .get(),
    );
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='processing_build_pages'",
        )
        .get(),
    );
    assert.ok(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_locators'",
        )
        .get(),
    );
    database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export package: 相对路径 manifest + dry snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-export-"));
  const dbPath = join(dir, "orynode.db");
  const filesDir = join(dir, "files");
  const outDir = join(dir, "out");
  mkdirSync(filesDir, { recursive: true });
  try {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    writeFileSync(join(filesDir, "abc123"), "hello export");
    database
      .prepare(
        `INSERT INTO knowledge_documents (
          id, name, original_name, content_hash, stored_path, size,
          page_count, chunk_count, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "doc-1",
        "hello.md",
        "hello.md",
        "abc123",
        join(filesDir, "abc123"),
        12,
        1,
        0,
        now,
        "ready",
      );
    database.close();

    const result = exportKnowledgePackage({
      projectRoot: dir,
      databasePath: dbPath,
      knowledgeFilesPath: filesDir,
      outDir,
    });
    assert.equal(result.documentCount, 1);
    assert.equal(result.manifest.formatVersion, 2);
    assert.ok(!looksLikeWindowsAbsolutePath(result.manifest.documents[0].storageKey));
    assert.equal(result.manifest.database.relativePath, "database/orynode.db");
    assert.ok(result.manifest.database.sha256);
    assert.ok(Array.isArray(result.manifest.files));
    assert.ok(result.manifest.files.some((f) => f.relativePath === "database/orynode.db"));
    assert.ok(result.manifest.files.every((f) => f.sha256 && f.size >= 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
