import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveKnowledgeTier,
  resolveRetrievalProfile,
} from "../../services/knowledge/retrieval/profile";
import { buildMultiQueries } from "../../services/knowledge/retrieval/multi-query";
import {
  detectQueryKind,
  shouldExpandQuery,
} from "../../services/knowledge/retrieval/query-type";
import { LexicalReranker } from "../../services/knowledge/retrieval/rerank";
import {
  createAgentSpace,
  assertAgentDocumentQuota,
  getAgentSpace,
  resetAgentSpaceMemoryForTests,
} from "../../services/agent/knowledge-tools";

const baseCaps = {
  ftsTokenizer: "fts5+bigram",
  externalConnectors: { web: true, github: true },
  resourcePressure: "normal" as const,
  rerankerType: "lexical" as const,
};

test("resolveKnowledgeTier: auto 有语义 → balanced", () => {
  const resolved = resolveKnowledgeTier("auto", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    memoryTier: "quality",
  });
  assert.equal(resolved.requestedTier, "auto");
  assert.equal(resolved.effectiveTier, "balanced");
  assert.deepEqual(resolved.degradedReasons, []);
});

test("resolveKnowledgeTier: auto 无语义 → lite", () => {
  const resolved = resolveKnowledgeTier("auto", {
    ...baseCaps,
    embedding: false,
    vectorIndexReady: false,
    reranker: true,
    memoryTier: "lite",
  });
  assert.equal(resolved.effectiveTier, "lite");
  assert.ok(
    resolved.degradedReasons.includes("SEMANTIC_SEARCH_DISABLED") ||
      resolved.degradedReasons.includes("SEMANTIC_RUNTIME_UNAVAILABLE"),
  );
});

test("resolveKnowledgeTier: auto 有 runtime 但向量未就绪 → lite", () => {
  const resolved = resolveKnowledgeTier("auto", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: false,
    reranker: true,
    memoryTier: "quality",
  });
  assert.equal(resolved.effectiveTier, "lite");
  assert.ok(resolved.degradedReasons.includes("VECTOR_INDEX_NOT_READY"));
});

test("resolveKnowledgeTier: 省资源 lite 不降级", () => {
  const resolved = resolveKnowledgeTier("lite", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    memoryTier: "quality",
  });
  assert.equal(resolved.effectiveTier, "lite");
  assert.deepEqual(resolved.degradedReasons, []);
});

test("resolveRetrievalProfile: lite 跳过向量", () => {
  const profile = resolveRetrievalProfile("lite", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    memoryTier: "balanced",
  });
  assert.equal(profile.effectiveTier, "lite");
  assert.equal(profile.embedding, false);
  assert.equal(profile.multiQuery, false);
});

test("resolveRetrievalProfile: quality 有重排 → quality", () => {
  const profile = resolveRetrievalProfile("quality", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    memoryTier: "quality",
  });
  assert.equal(profile.effectiveTier, "quality");
  assert.equal(profile.multiQuery, true);
  assert.equal(profile.rerank, true);
});

test("resolveRetrievalProfile: quality 无 reranker → balanced", () => {
  const profile = resolveRetrievalProfile("quality", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: false,
    memoryTier: "quality",
  });
  assert.equal(profile.effectiveTier, "balanced");
  assert.ok(profile.degradedReasons.includes("RERANKER_UNAVAILABLE"));
});

test("resolveRetrievalProfile: quality 资源压力 → balanced", () => {
  const profile = resolveRetrievalProfile("quality", {
    ...baseCaps,
    embedding: true,
    vectorIndexReady: true,
    reranker: true,
    memoryTier: "quality",
    resourcePressure: "high",
  });
  assert.equal(profile.effectiveTier, "balanced");
  assert.ok(profile.degradedReasons.includes("RESOURCE_PRESSURE"));
});

test("resolveRetrievalProfile: 主机 memoryTier 封顶", () => {
  const profile = resolveRetrievalProfile("quality", {
    ...baseCaps,
    embedding: false,
    vectorIndexReady: false,
    reranker: false,
    memoryTier: "lite",
  });
  assert.equal(profile.effectiveTier, "lite");
  assert.ok(profile.degradedReasons.length > 0);
});

test("detectQueryKind: 精确类查询", () => {
  assert.equal(detectQueryKind('"安装步骤"'), "exact_phrase");
  assert.equal(detectQueryKind("手册.pdf"), "filename");
  assert.equal(detectQueryKind("ERR_CONNECTION_REFUSED"), "error_code");
  assert.equal(detectQueryKind("KnowledgeEngine.retrieve()"), "symbol");
  assert.equal(detectQueryKind("如何安装本地知识引擎"), "general");
});

test("buildMultiQueries: 原句 + 变体", () => {
  const queries = buildMultiQueries("Orynode 本地知识引擎 Knowledge");
  assert.ok(queries.length >= 2);
  assert.equal(queries[0], "Orynode 本地知识引擎 Knowledge");
  assert.ok(queries.length <= 3);
});

test("buildMultiQueries: 精确查询不扩展", () => {
  assert.deepEqual(buildMultiQueries("手册.pdf"), ["手册.pdf"]);
  assert.deepEqual(buildMultiQueries("ERR_CONNECTION_REFUSED"), [
    "ERR_CONNECTION_REFUSED",
  ]);
  assert.equal(shouldExpandQuery("手册.pdf"), false);
});

test("LexicalReranker: 按关键词重叠排序", async () => {
  const reranker = new LexicalReranker();
  const ranked = await reranker.rerank(
    "知识引擎",
    [
      { id: "a", text: "无关内容 hello" },
      { id: "b", text: "本地知识引擎说明" },
    ],
    2,
  );
  assert.equal(ranked[0]?.id, "b");
});

test("LexicalReranker: 全零分保持输入顺序（ADR-ML-005）", () => {
  const reranker = new LexicalReranker();
  const result = reranker.rerankWithMeta(
    "how to rebuild the vector index offline",
    [
      { id: "vec-first", text: "向量召回的中文段落，语义相关但无英文字面重合" },
      { id: "vec-second", text: "另一段同样只有中文说明的资料正文" },
    ],
    2,
  );
  assert.equal(result.preservedOrder, true);
  assert.deepEqual(
    result.items.map((row) => row.id),
    ["vec-first", "vec-second"],
  );
});

test("applyLexicalBoost: 不覆盖融合分仅小幅提升", async () => {
  const { applyLexicalBoost } = await import(
    "../../services/knowledge/retrieval/rerank"
  );
  const boosted = applyLexicalBoost(
    [
      { id: "a", score: 1.0 },
      { id: "b", score: 0.9 },
    ],
    [
      { id: "a", score: 1 },
      { id: "b", score: 100 },
    ],
    0.05,
  );
  // b 获得 boost 但仍接近原融合量级；不得变成 lexical 原始分 100
  assert.ok(boosted[0]!.score < 2);
  assert.ok((boosted.find((r) => r.id === "b")?.score ?? 0) > 0.9);
});

test("Agent space: 配额与 TTL 字段", async () => {
  resetAgentSpaceMemoryForTests();
  const space = createAgentSpace({ ownerRef: "session-1", maxDocuments: 2 });
  assert.equal(space.kind, "agent");
  assert.equal(space.lifecycle, "scoped");
  await assertAgentDocumentQuota("session-1", "doc-a");
  await assertAgentDocumentQuota("session-1", "doc-b");
  await assert.rejects(
    () => assertAgentDocumentQuota("session-1", "doc-c"),
    /上限/,
  );
  assert.equal(getAgentSpace("session-1")?.documentIds.length, 2);
});
