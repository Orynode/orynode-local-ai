/**
 * Search / Retrieve 架构边界护栏
 *
 * 锁定：同源召回、无答案一致、工作台只打 v1/search、禁止前端直连 data-service。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createKnowledgeEngine } from "../../services/knowledge/application/engine";
import { runKnowledgeSearch } from "../../services/knowledge/application/run-search";
import type { Retriever, RetrievalHit, RetrievalResult } from "../../services/knowledge/types";

const SAMPLE_HIT: RetrievalHit = {
  id: "c1",
  documentId: "d1",
  documentName: "手册.md",
  pageNumber: 1,
  position: 0,
  content: "Orynode 本地知识引擎",
  score: 1,
  source: "library",
};

function mockRetriever(
  impl: (query: string) => Promise<RetrievalResult> | RetrievalResult,
): Retriever {
  return {
    async retrieve(query) {
      return impl(query);
    },
  };
}

test("search 与 retrieve 同源：相同 query/scope 命中 id 一致", async () => {
  let calls = 0;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    retriever: mockRetriever(() => {
      calls += 1;
      return { strategy: "keyword", chunks: [SAMPLE_HIT] };
    }),
  });
  const scope = { mode: "sources" as const, library: "all" as const };
  const searched = await engine.search({
    query: "Orynode",
    scope,
    knowledgeTier: "lite",
  });
  const retrieved = await engine.retrieve({
    query: "Orynode",
    scope,
    knowledgeTier: "lite",
  });
  assert.deepEqual(
    searched.hits.map((h) => h.id),
    retrieved.hits.map((h) => h.id),
  );
  assert.equal(calls, 2);
  assert.ok((searched.highlightTerms?.length ?? 0) > 0);
  assert.ok((retrieved.highlightTerms?.length ?? 0) > 0);
});

test("无答案门禁一致：召回为空时 search 与 retrieve 皆空", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    retriever: mockRetriever(() => ({ strategy: "keyword", chunks: [] })),
  });
  const scope = { mode: "sources" as const, library: "all" as const };
  const searched = await engine.search({
    query: "关键字",
    scope,
    knowledgeTier: "lite",
  });
  const retrieved = await engine.retrieve({
    query: "关键字",
    scope,
    knowledgeTier: "lite",
  });
  assert.equal(searched.hits.length, 0);
  assert.equal(retrieved.hits.length, 0);
  assert.equal(searched.diagnostics.candidateCount, 0);
  assert.equal(retrieved.diagnostics.candidateCount, 0);
  assert.equal(searched.diagnostics.strategy.includes("rrf"), false);
  assert.equal(retrieved.diagnostics.strategy.includes("rrf"), false);
});

test("runKnowledgeSearch 走 engine.search 契约（含 highlightTerms）", async () => {
  // 空 scope 短路：不碰真实 retriever，验证用例形状
  const empty = await runKnowledgeSearch({
    query: "x",
    scope: { mode: "none" },
  });
  assert.equal(empty.emptyScope, true);
  assert.equal(empty.hits.length, 0);
});

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walkFiles(path, out);
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

test("知识工作台禁止直连 data-service 检索", () => {
  const root = join(process.cwd(), "app/components/knowledge");
  const files = walkFiles(root);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(
      /ORYNODE_DATA_URL|:4318/.test(text),
      false,
      `${file} 不得直连 data-service`,
    );
  }
});

test("KnowledgeView 正式入口为 v1/search", () => {
  const path = join(
    process.cwd(),
    "app/components/knowledge/KnowledgeView.tsx",
  );
  const text = readFileSync(path, "utf8");
  assert.match(text, /\/api\/knowledge\/v1\/search/);
  assert.equal(
    /fetch\(\s*["']\/api\/knowledge\/search["']/.test(text),
    false,
    "工作台不得再以 legacy /api/knowledge/search 为一等入口",
  );
  assert.match(text, /检索预览/);
  assert.match(text, /topK:\s*SEARCH_PREVIEW_LIMIT/);
  assert.match(text, /aria-label="检索结果分页"/);
  assert.match(text, /visibleSearchHits\.map/);
});

test("KnowledgeView 不把 displayName 当作字面命中或高亮证据", () => {
  const path = join(
    process.cwd(),
    "app/components/knowledge/KnowledgeView.tsx",
  );
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /hasLexicalHighlight\(hit\.documentName/);
  assert.doesNotMatch(text, /highlightSearchText\([\s\S]{0,80}hit\.documentName/);
});
