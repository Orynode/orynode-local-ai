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

    // legacy search_text 不含简繁扩展；查询侧 OR 变体应仍能命中简体正文
    const legacyHant = searchKeywordIndex(database, {
      query: "訪問令牌",
      library: { mode: "all" },
      topK: 3,
      preferLegacy: true,
    });
    assert.equal(legacyHant.strategy, "fts5");
    assert.ok(
      legacyHant.chunks.some((c) => c.id === "c3"),
      "legacy FTS 应靠查询简繁 OR 命中简体「访问令牌」",
    );

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

test("FTS: 多词默认 AND；无交集时不退化为任意词 OR", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-and", "and.md", "/tmp/and.md", 10, 1, 3, now, "ready");

    const rows = [
      ["a1", "本地知识库用于私有检索。"],
      ["a2", "知识引擎负责摄取。"],
      ["a3", "完全无关的天气说明。"],
    ];
    for (const [id, content] of rows) {
      database
        .prepare(
          `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, "d-and", 1, rows.findIndex((r) => r[0] === id), content);
    }
    upsertFtsChunks(
      database,
      "library",
      "d-and",
      rows.map(([id, content]) => ({ id, content })),
    );

    const andHit = searchKeywordIndex(database, {
      query: "知识 引擎",
      terms: ["知识", "引擎"],
      library: { mode: "all" },
      topK: 8,
    });
    assert.ok(
      andHit.strategy === "fts5_v2" || andHit.strategy === "fts5",
      andHit.strategy,
    );
    assert.ok(andHit.chunks.some((c) => c.id === "a2"));
    assert.ok(!andHit.chunks.some((c) => c.id === "a3"));

    const noLooseOr = searchKeywordIndex(database, {
      query: "知识 天气",
      terms: ["知识", "天气"],
      queryClass: "general",
      lexicalLadder: [
        { mode: "all", terms: ["知识", "天气"] },
      ],
      library: { mode: "all" },
      topK: 8,
    });
    assert.equal(noLooseOr.chunks.length, 0);
    assert.equal(
      noLooseOr.degradedReasons?.includes("FTS_AND_EMPTY_OR_FALLBACK"),
      undefined,
    );
    database.close();
  });
});

test("FTS: 钠离子电池 不命中仅含「电池」的段落，且策略为 phrase 级", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-bat", "bat.md", "/tmp/bat.md", 10, 1, 3, now, "ready");

    const rows = [
      ["b1", "钠离子电池需要专用电解质与电极材料。"],
      ["b2", "本章介绍普通电池容量与循环寿命。"],
      ["b3", "锂离子电池已经广泛商用。"],
    ];
    for (const [id, content] of rows) {
      database
        .prepare(
          `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, "d-bat", 1, rows.findIndex((r) => r[0] === id), content);
    }
    upsertFtsChunks(
      database,
      "library",
      "d-bat",
      rows.map(([id, content]) => ({ id, content })),
    );

    const q = "钠离子电池";
    const terms = ["钠离子电池", "电池", "子电", "离子", "钠离"];
    const result = searchKeywordIndex(database, {
      query: q,
      phrase: q,
      terms,
      queryClass: "zh_compound",
      lexicalLadder: [
        { mode: "phrase", phrase: q, terms },
        { mode: "all", terms },
      ],
      languagePrimary: "zh-Hans",
      library: { mode: "all" },
      topK: 8,
    });

    const ids = result.chunks.map((c) => c.id);
    assert.deepEqual(ids, ["b1"]);
    assert.equal(result.strategy, "fts5_phrase");
    database.close();
  });
});

test("FTS: 中文短复合「反向代理」不因单 bigram「代理」命中", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-proxy", "proxy.md", "/tmp/proxy.md", 10, 1, 2, now, "ready");

    const rows = [
      ["rp1", "在网关层配置反向代理，将请求转到上游服务。"],
      ["rp2", "浏览器代理设置与正向代理说明，不含反向配置。"],
    ];
    for (const [id, content] of rows) {
      database
        .prepare(
          `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, "d-proxy", 1, rows.findIndex((r) => r[0] === id), content);
    }
    upsertFtsChunks(
      database,
      "library",
      "d-proxy",
      rows.map(([id, content]) => ({ id, content })),
    );

    const result = searchKeywordIndex(database, {
      query: "反向代理",
      phrase: "反向代理",
      terms: ["反向代理", "反向", "向代", "代理"],
      queryClass: "zh_compound",
      lexicalLadder: [
        { mode: "phrase", phrase: "反向代理", terms: ["反向代理", "反向", "向代", "代理"] },
        { mode: "all", terms: ["反向代理", "反向", "向代", "代理"] },
      ],
      languagePrimary: "zh-Hans",
      library: { mode: "all" },
      topK: 8,
    });

    const ids = result.chunks.map((c) => c.id);
    assert.ok(ids.includes("rp1"), `expected rp1, got ${ids.join(",")}`);
    assert.ok(!ids.includes("rp2"), `noise rp2 must not match: ${ids.join(",")}`);
    database.close();
  });
});

test("FTS v2: languagePrimary=en 偏向英文列", () => {
  withTempDb((dbPath) => {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO knowledge_documents
          (id, name, stored_path, size, page_count, chunk_count, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("d-lang", "lang.md", "/tmp/lang.md", 10, 1, 2, now, "ready");
    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("en1", "d-lang", 1, 0, "Hybrid retrieval combines keyword search with vectors.");
    database
      .prepare(
        `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("zh1", "d-lang", 1, 1, "混合检索把关键词与向量结合。");
    upsertFtsChunks(database, "library", "d-lang", [
      {
        id: "en1",
        content: "Hybrid retrieval combines keyword search with vectors.",
      },
      { id: "zh1", content: "混合检索把关键词与向量结合。" },
    ]);

    const en = searchKeywordIndex(database, {
      query: "retrieval keyword",
      terms: ["retrieval", "keyword"],
      languagePrimary: "en",
      library: { mode: "all" },
      topK: 5,
    });
    assert.ok(en.chunks.some((c) => c.id === "en1"));
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
