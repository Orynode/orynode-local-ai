import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import {
  isFtsReady,
  isFtsV2Ready,
  searchKeywordIndex,
  upsertFtsChunks,
} from "../../scripts/data-service/fts-index.mjs";

function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-fts-"));
  const dbPath = join(dir, "test.db");
  try {
    return run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("FTS5: 建索引后可按中文 bigram 召回 topK", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    assert.equal(isFtsReady(database), true);

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d1", "架构.md", "/tmp/a.md", 10, 1, 2, now, "ready");

    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("c1", "d1", 1, 0, "无关内容");
    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("c2", "d1", 1, 1, "Orynode AI 知识引擎负责摄取与检索。");

    upsertFtsChunks(database, "library", "d1", [
      { id: "c1", content: "无关内容" },
      { id: "c2", content: "Orynode AI 知识引擎负责摄取与检索。" },
    ]);

    const result = searchKeywordIndex(database, {
      query: "知识引擎",
      library: { mode: "all" },
      topK: 5,
    });

    assert.ok(result.strategy === "fts5_v2" || result.strategy === "fts5");
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.chunks[0]?.id, "c2");
    assert.ok(result.chunks.length <= 5);
    database.close();
  });
});

test("FTS v2: Node.js / 简繁 与 dual-write", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    assert.equal(isFtsV2Ready(database), true);

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d2", "node.md", "/tmp/n.md", 10, 1, 1, now, "ready");
    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("c3", "d2", 1, 0, "在 Node.js 中配置访问令牌 access-token。");

    upsertFtsChunks(database, "library", "d2", [
      { id: "c3", content: "在 Node.js 中配置访问令牌 access-token。" },
    ]);

    const byTech = searchKeywordIndex(database, {
      query: "Node.js access-token",
      library: { mode: "all" },
      topK: 3,
    });
    assert.equal(byTech.strategy, "fts5_v2");
    assert.equal(byTech.chunks[0]?.id, "c3");

    const byHant = searchKeywordIndex(database, {
      query: "訪問令牌",
      library: { mode: "all" },
      topK: 3,
    });
    assert.ok(byHant.chunks.some((c) => c.id === "c3"));

    const legacy = searchKeywordIndex(database, {
      query: "访问令牌",
      library: { mode: "all" },
      topK: 3,
      preferLegacy: true,
    });
    assert.equal(legacy.strategy, "fts5");
    database.close();
  });
});

test("FTS v2: 短语命中优先，不退化为单词 OR", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database.prepare(
      `INSERT INTO knowledge_documents
        (id, name, stored_path, size, page_count, chunk_count, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("d-phrase", "minecraft.md", "/tmp/minecraft.md", 10, 1, 3, now, "ready");

    const rows = [
      ["p1", "Passive Mobs are friendly creatures."],
      ["p2", "Mobs may become passive after taming."],
      ["p3", "Hostile mobs spawn at night."],
    ];
    for (const [id, content] of rows) {
      database.prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, "d-phrase", 1, rows.findIndex((row) => row[0] === id), content);
    }
    upsertFtsChunks(
      database,
      "library",
      "d-phrase",
      rows.map(([id, content]) => ({ id, content })),
    );

    const result = searchKeywordIndex(database, {
      query: "Passive Mobs",
      phrase: "Passive Mobs",
      terms: ["passive", "mobs"],
      library: { mode: "all" },
      topK: 8,
    });

    assert.equal(result.strategy, "fts5_phrase");
    assert.deepEqual(result.chunks.map((chunk) => chunk.id), ["p1"]);
    database.close();
  });
});

test("migrateDatabase: 应用 FTS 与 citation 迁移", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    const first = migrateDatabase(database);
    assert.ok(first.applied.includes("001_baseline"));
    assert.ok(first.applied.includes("002_fts5_keyword_index"));
    assert.ok(first.applied.includes("003_message_citations"));
    assert.ok(first.applied.includes("004_jobs_and_versioned_index"));
    assert.ok(first.applied.includes("005_sources_connectors"));
    assert.ok(first.applied.includes("013_fts_v2_multilingual"));

    const columns = database.prepare(`PRAGMA table_info(messages)`).all();
    const names = new Set(columns.map((row) => row.name));
    assert.ok(names.has("citations"));
    assert.ok(names.has("referenced_citation_ids"));
    assert.ok(names.has("retrieval_trace_id"));
    database.close();
  });
});
