import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  getAppliedMigrations,
  migrateDatabase,
  tableExists,
} from "../../scripts/data-service/migrations/index.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-migrate-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migrateDatabase: 全新库应用 001_baseline", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    const result = migrateDatabase(database);
    assert.deepEqual(result.applied, [
      "001_baseline",
      "002_fts5_keyword_index",
      "003_message_citations",
      "004_jobs_and_versioned_index",
      "005_sources_connectors",
      "006_source_search_visibility",
      "007_vector_entries",
      "008_processing_builds_spaces",
      "009_agent_spaces",
      "010_ocr_document_blocks",
      "011_processing_build_pages",
      "012_chunk_locators",
      "013_fts_v2_multilingual",
    ]);
    assert.equal(tableExists(database, "schema_migrations"), true);
    assert.equal(tableExists(database, "knowledge_documents"), true);
    assert.equal(tableExists(database, "processing_build_pages"), true);
    assert.equal(tableExists(database, "chunk_locators"), true);
    assert.equal(tableExists(database, "knowledge_chunks_fts_v2"), true);
    assert.equal(tableExists(database, "conversation_files"), true);
    assert.equal(tableExists(database, "jobs"), true);
    assert.equal(tableExists(database, "index_builds"), true);
    assert.equal(tableExists(database, "sources"), true);
    assert.equal(tableExists(database, "source_items"), true);
    assert.equal(tableExists(database, "library_search_exclusions"), true);
    assert.equal(tableExists(database, "vector_entries"), true);
    assert.equal(tableExists(database, "processing_builds"), true);
    assert.equal(tableExists(database, "knowledge_spaces"), true);
    assert.equal(tableExists(database, "storage_staging"), true);
    assert.ok(getAppliedMigrations(database).has("001_baseline"));
    assert.ok(getAppliedMigrations(database).has("002_fts5_keyword_index"));
    assert.ok(getAppliedMigrations(database).has("004_jobs_and_versioned_index"));
    assert.ok(getAppliedMigrations(database).has("005_sources_connectors"));
    assert.ok(getAppliedMigrations(database).has("008_processing_builds_spaces"));
    assert.ok(getAppliedMigrations(database).has("009_agent_spaces"));

    const second = migrateDatabase(database);
    assert.deepEqual(second.applied, []);
    assert.ok(second.skipped.includes("001_baseline"));
    database.close();
  });
});

test("migrateDatabase: 旧库缺列时可补齐且不丢数据", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    database.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO knowledge_documents
        (id, name, stored_path, size, page_count, chunk_count, created_at)
      VALUES ('doc-1', '旧文档', '/tmp/a.pdf', 10, 1, 1, '2026-01-01T00:00:00.000Z');
    `);

    migrateDatabase(database);

    const row = database
      .prepare(`SELECT id, name, status, content_hash FROM knowledge_documents WHERE id = ?`)
      .get("doc-1");
    assert.equal(row.name, "旧文档");
    assert.equal(row.status, "ready");
    assert.equal(row.content_hash, null);
    assert.ok(getAppliedMigrations(database).has("001_baseline"));
    database.close();
  });
});

test("migrateDatabase: 备份文件可复制恢复", () => {
  withTempDb((dbPath, dir) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    database
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run("c1", "备份会话", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.close();

    const backupDir = join(dir, "backup");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, "orynode.db");
    copyFileSync(dbPath, backupPath);
    assert.equal(existsSync(backupPath), true);

    const restored = new DatabaseSync(backupPath);
    migrateDatabase(restored);
    const row = restored
      .prepare(`SELECT title FROM conversations WHERE id = ?`)
      .get("c1");
    assert.equal(row.title, "备份会话");
    restored.close();
  });
});
