/**
 * 真实 FTS5 门禁：用 multilingual-p0 fixture 建临时库，校验生产路径 BM25 召回。
 * 与离线 keywordScore eval 互补，避免「stub 绿、FTS 红」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../../scripts/data-service/migrations/index.mjs";
import {
  searchKeywordIndex,
  upsertFtsChunks,
} from "../../scripts/data-service/fts-index.mjs";
import { extractSearchTerms } from "../../scripts/data-service/search-text.mjs";
import {
  buildLexicalLadder,
  classifyQuery,
  isZhShortCompound,
} from "../../scripts/data-service/lexical-coverage.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/rag/multilingual-p0.json", import.meta.url),
    "utf8",
  ),
);

function withFixtureDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "orynode-fts-eval-"));
  const dbPath = join(dir, "eval.db");
  try {
    const database = new DatabaseSync(dbPath);
    migrateDatabase(database);
    const now = new Date().toISOString();
    const byDoc = new Map();
    for (const chunk of fixture.corpus) {
      const list = byDoc.get(chunk.documentId) ?? [];
      list.push(chunk);
      byDoc.set(chunk.documentId, list);
    }
    let docIndex = 0;
    for (const [documentId, chunks] of byDoc) {
      database
        .prepare(
          `INSERT INTO knowledge_documents
            (id, name, stored_path, size, page_count, chunk_count, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          documentId,
          `${documentId}.md`,
          `/tmp/${documentId}.md`,
          10,
          1,
          chunks.length,
          now,
          "ready",
        );
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        database
          .prepare(
            `INSERT INTO knowledge_chunks (id, document_id, page_number, position, content)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(chunk.id, documentId, 1, i, chunk.text);
      }
      upsertFtsChunks(
        database,
        "library",
        documentId,
        chunks.map((c) => ({ id: c.id, content: c.text })),
      );
      docIndex += 1;
    }
    void docIndex;
    run(database);
    database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("真实 FTS5 门禁: multilingual-p0 关键词用例命中金标", () => {
  withFixtureDb((database) => {
    const keywordCases = fixture.cases.filter((c) =>
      (c.gateStrategies ?? []).includes("keyword"),
    );
    assert.ok(keywordCases.length >= 3);

    let hit = 0;
    for (const item of keywordCases) {
      const terms = extractSearchTerms(item.query);
      const phrase = isZhShortCompound(item.query)
        ? item.query.trim()
        : undefined;
      const queryClass = classifyQuery({
        query: item.query,
        phrase,
        searchTerms: terms,
        hasHan: /[\u4e00-\u9fff]/.test(item.query),
        hasLatin: /[A-Za-z]/.test(item.query),
      });
      const result = searchKeywordIndex(database, {
        query: item.query,
        terms,
        phrase,
        queryClass,
        lexicalLadder: buildLexicalLadder({ queryClass, phrase, terms }),
        library: { mode: "all" },
        topK: 8,
      });
      const ids = new Set(result.chunks.map((c) => c.id));
      const ok = item.relevantChunkIds.some((id) => ids.has(id));
      if (ok) hit += 1;
      assert.ok(
        ok,
        `case ${item.id} query="${item.query}" expected one of ${item.relevantChunkIds.join(",")} got [${[...ids].join(",")}] strategy=${result.strategy}`,
      );
    }
    assert.equal(hit, keywordCases.length);
  });
});
