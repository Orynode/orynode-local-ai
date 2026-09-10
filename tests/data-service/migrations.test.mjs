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
import { up as wikiMaturityUp } from "../../scripts/data-service/migrations/024_wiki_maturity.mjs";
import { up as wikiSourceUniqueUp } from "../../scripts/data-service/migrations/026_wiki_source_unique.mjs";

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
      "014_terminology_entries",
      "015_chunk_text_locators",
      "016_document_file_kind",
      "017_preview_path",
      "018_wiki_pages",
      "019_wiki_synthesis",
      "020_wiki_graph",
      "021_wiki_notes",
      "022_wiki_knowledge",
      "023_wiki_compile_runs",
      "024_wiki_maturity",
      "025_wiki_revisions",
      "026_wiki_source_unique",
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
    assert.equal(tableExists(database, "terminology_entries"), true);
    assert.equal(tableExists(database, "wiki_pages"), true);
    {
      const wikiColumns = new Set(
        database
          .prepare(`PRAGMA table_info(wiki_pages)`)
          .all()
          .map((row) => row.name),
      );
      assert.ok(wikiColumns.has("synthesis_markdown"));
      assert.ok(wikiColumns.has("synthesis_compiler"));
      assert.ok(wikiColumns.has("user_edited"));
      assert.ok(wikiColumns.has("wiki_build_id"));
      assert.ok(wikiColumns.has("notes_markdown"));
      assert.ok(wikiColumns.has("knowledge_json"));
    }
    {
      const wikiIndexes = database.prepare(`PRAGMA index_list(wiki_pages)`).all();
      assert.ok(
        wikiIndexes.some((row) => row.name === "idx_wiki_pages_source" && row.unique),
      );
    }
    assert.equal(tableExists(database, "wiki_links"), true);
    assert.equal(tableExists(database, "wiki_builds"), true);
    assert.equal(tableExists(database, "wiki_compile_runs"), true);
    assert.equal(tableExists(database, "wiki_decisions"), true);
    assert.equal(tableExists(database, "wiki_pending_edges"), true);
    assert.equal(tableExists(database, "wiki_candidates"), true);
    assert.equal(tableExists(database, "wiki_page_revisions"), true);
    for (const table of ["knowledge_chunks", "conversation_file_chunks"]) {
      const columns = new Set(
        database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
      );
      assert.ok(columns.has("start_line"));
      assert.ok(columns.has("end_line"));
      assert.ok(columns.has("heading_path"));
    }
    for (const table of ["knowledge_documents", "conversation_files"]) {
      const columns = new Set(
        database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
      );
      assert.ok(columns.has("file_kind"), `${table} 应有 file_kind`);
      assert.ok(columns.has("preview_path"), `${table} 应有 preview_path`);
    }
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

test("024_wiki_maturity: 加表不破坏 wiki_pages 行", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    database
      .prepare(
        `INSERT INTO wiki_pages (
          id, slug, title, kind, namespace, source_document_id,
          markdown, sections_json, compiler, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "mirror:library:doc-keep",
        "mirror:library:doc-keep",
        "保留页",
        "document_mirror",
        "library",
        "doc-keep",
        "# 保留",
        "[]",
        "heading_extract_v1",
        "ready",
        "2026-09-09T00:00:00.000Z",
        "2026-09-09T00:00:00.000Z",
      );
    wikiMaturityUp(database);
    const row = database
      .prepare(`SELECT title FROM wiki_pages WHERE id = ?`)
      .get("mirror:library:doc-keep");
    assert.equal(row.title, "保留页");
    assert.equal(tableExists(database, "wiki_decisions"), true);
    database.close();
  });
});

test("026_wiki_source_unique: 清重复后建立 UNIQUE", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    database.exec(`DROP INDEX IF EXISTS idx_wiki_pages_source`);
    const insert = database.prepare(`
      INSERT INTO wiki_pages (
        id, slug, title, kind, namespace, source_document_id,
        markdown, sections_json, compiler, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "mirror:library:keep",
      "mirror:library:keep",
      "新页",
      "document_mirror",
      "library",
      "dup-src",
      "# 新",
      "[]",
      "heading_extract_v1",
      "ready",
      "2026-09-10T00:00:00.000Z",
      "2026-09-10T01:00:00.000Z",
    );
    insert.run(
      "mirror:library:drop",
      "mirror:library:drop",
      "旧页",
      "document_mirror",
      "library",
      "dup-src",
      "# 旧",
      "[]",
      "heading_extract_v1",
      "ready",
      "2026-09-09T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
    );
    wikiSourceUniqueUp(database);
    const rows = database
      .prepare(`SELECT id FROM wiki_pages WHERE source_document_id = ?`)
      .all("dup-src");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "mirror:library:keep");
    database.close();
  });
});
