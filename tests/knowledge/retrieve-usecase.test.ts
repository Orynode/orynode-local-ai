import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatKnowledgeContext,
  createKnowledgeEngine,
  RETRIEVAL_EMPTY_CONTEXT,
  RETRIEVAL_FAILURE_CONTEXT,
} from "../../services/knowledge/application/engine";
import { EMPTY_REWRITE, rewriteFromEntries } from "../../services/knowledge/query/terminology-match";
import { BUILTIN_TERMINOLOGY } from "../../services/knowledge/query/terminology";
import type { StructuredQueryRewrite } from "../../services/knowledge/query/query-rewrite";
import type { Retriever, RetrievalResult } from "../../services/knowledge/types";

/** 单元测试默认不打真实 LLM / 术语 API */
async function noRewrite(): Promise<StructuredQueryRewrite> {
  return { ...EMPTY_REWRITE };
}

function mockRetriever(
  impl: (query: string) => Promise<RetrievalResult> | RetrievalResult,
): Retriever {
  return {
    async retrieve(query) {
      return impl(query);
    },
  };
}

test("buildChatKnowledgeContext: scope none 不检索", async () => {
  let called = 0;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      called += 1;
      return { chunks: [], strategy: "keyword" };
    }),
  });
  const result = await buildChatKnowledgeContext(engine, {
    messages: [{ role: "user", content: "你好" }],
    retrievalScope: { mode: "none" },
  });
  assert.equal(result.knowledgePrompt, "");
  assert.equal(result.retrieval, null);
  assert.equal(called, 0);
});

test("buildChatKnowledgeContext: 有命中时组装 context", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => ({
      strategy: "keyword",
      chunks: [
        {
          id: "c1",
          documentId: "d1",
          documentName: "手册.md",
          pageNumber: 1,
          position: 0,
          content: "Orynode 是本地 AI 服务器",
          score: 4,
          source: "library",
        },
      ],
    })),
  });

  const result = await buildChatKnowledgeContext(engine, {
    messages: [{ role: "user", content: "Orynode 是什么" }],
    retrievalScope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });

  assert.match(result.knowledgePrompt, /本地资料库/);
  assert.match(result.knowledgePrompt, /\[S1\]/);
  assert.match(result.knowledgePrompt, /Orynode 是本地 AI 服务器/);
  assert.equal(result.retrieval?.hits.length, 1);
  assert.equal(result.context?.citations[0]?.id, "S1");
  assert.equal(result.context?.citations[0]?.revisionId, "legacy");
});

test("buildChatKnowledgeContext: 检索失败降级文案", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      throw new Error("data service down");
    }),
  });
  const result = await buildChatKnowledgeContext(engine, {
    messages: [{ role: "user", content: "查询资料" }],
    retrievalScope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });
  assert.equal(result.knowledgePrompt, RETRIEVAL_FAILURE_CONTEXT);
});

test("buildChatKnowledgeContext: 0 命中注入诚实文案并保留 diagnostics", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => ({
      strategy: "keyword",
      chunks: [],
    })),
  });
  const result = await buildChatKnowledgeContext(engine, {
    messages: [{ role: "user", content: "查询资料" }],
    retrievalScope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });
  assert.equal(result.knowledgePrompt, RETRIEVAL_EMPTY_CONTEXT);
  assert.equal(result.retrieval?.hits.length, 0);
  assert.ok(result.retrieval?.diagnostics);
});

test("retrieve: hybrid diagnostics 不含 vector 降级", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "balanced",
    resolveRewrite: noRewrite,
    capabilities: {
      embedding: true,
      reranker: false,
      ftsTokenizer: "fts5+bigram",
      memoryTier: "balanced",
      externalConnectors: { web: true, github: true },
    },
    retriever: mockRetriever(() => ({
      strategy: "hybrid",
      chunks: [
        {
          id: "c1",
          documentId: "d1",
          documentName: "a",
          pageNumber: 1,
          position: 0,
          content: "x",
          score: 1,
          source: "library",
        },
      ],
    })),
  });
  const response = await engine.retrieve({
    query: "x",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "balanced",
  });
  assert.ok(response.diagnostics.strategy.includes("keyword"));
  assert.ok(response.diagnostics.strategy.includes("vector"));
  assert.ok(response.diagnostics.strategy.includes("rrf"));
  assert.deepEqual(response.diagnostics.degradedCapabilities, []);
});

test("retrieve: phrase 短路仅关键词时不误报向量索引未就绪", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "balanced",
    resolveRewrite: noRewrite,
    capabilities: {
      embedding: true,
      vectorIndexReady: true,
      reranker: false,
      ftsTokenizer: "fts5-multilingual-v1",
      memoryTier: "balanced",
      externalConnectors: { web: true, github: true },
    },
    retriever: mockRetriever(() => ({
      // 模拟 hybridSearch 在 fts5_phrase 命中后的短路返回
      strategy: "keyword",
      chunks: [
        {
          id: "phrase-hit",
          documentId: "d1",
          documentName: "proxy.md",
          pageNumber: 1,
          position: 0,
          content: "nginx 反向代理配置",
          score: 5,
          source: "library",
        },
      ],
    })),
  });
  const response = await engine.retrieve({
    query: "反向代理",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "auto",
  });
  assert.equal(response.diagnostics.effectiveTier, "balanced");
  assert.equal(response.diagnostics.fusion, "keyword_only");
  assert.ok(response.diagnostics.strategy.includes("keyword"));
  assert.equal(
    response.diagnostics.degradedCapabilities.includes("VECTOR_INDEX_NOT_READY"),
    false,
  );
  assert.deepEqual(response.diagnostics.degradedCapabilities, []);
});

test("retrieve: 术语 rewrite 经 term_expansion 召回英文 access token", async () => {
  const calls: string[] = [];
  const preferKeywordByQuery = new Map<string, boolean | undefined>();
  const engine = createKnowledgeEngine({
    knowledgeTier: "balanced",
    resolveRewrite: async (query) =>
      rewriteFromEntries(query, BUILTIN_TERMINOLOGY, "terminology"),
    capabilities: {
      embedding: true,
      reranker: false,
      ftsTokenizer: "fts5-multilingual-v1",
      memoryTier: "balanced",
      externalConnectors: { web: true, github: true },
    },
    retriever: {
      async retrieve(query, _scope, options) {
        calls.push(query);
        preferKeywordByQuery.set(query, options?.preferKeyword);
        if (/access/i.test(query)) {
          return {
            strategy: "keyword",
            chunks: [
              {
                id: "en-access",
                documentId: "d-en",
                documentName: "auth.md",
                pageNumber: 1,
                position: 0,
                content: "Issue an access token for the API client.",
                score: 3,
                source: "library",
              },
            ],
          };
        }
        return { strategy: "hybrid", chunks: [] };
      },
    },
  });

  const response = await engine.retrieve({
    query: "访问令牌",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "balanced",
  });

  assert.ok(calls.some((query) => /access/i.test(query)));
  assert.equal(preferKeywordByQuery.get("访问令牌"), false);
  assert.ok(
    [...preferKeywordByQuery.entries()].some(
      ([q, prefer]) => /access/i.test(q) && prefer === true,
    ),
  );
  assert.equal(response.hits[0]?.id, "en-access");
  assert.ok((response.hits[0]?.score ?? 0) > 0);
  assert.ok(response.diagnostics.strategy.includes("keyword"));
  assert.ok(response.highlightTerms?.some((t) => /access/i.test(t)));
});

test("retrieve: normalized 词项变体只走 FTS，不放大向量噪声", async () => {
  const modes = new Map<string, boolean | undefined>();
  const engine = createKnowledgeEngine({
    knowledgeTier: "quality",
    resolveRewrite: noRewrite,
    capabilities: {
      embedding: true,
      reranker: true,
      rerankerType: "lexical",
      ftsTokenizer: "fts5-multilingual-v1",
      memoryTier: "quality",
      externalConnectors: { web: true, github: true },
    },
    retriever: {
      async retrieve(query, _scope, options) {
        modes.set(query, options?.preferKeyword);
        return { strategy: options?.preferKeyword ? "keyword" : "hybrid", chunks: [] };
      },
    },
  });

  const response = await engine.retrieve({
    query: "原子刻度相关内容",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "quality",
  });
  assert.equal(modes.get("原子刻度相关内容"), false);
  for (const [query, preferKeyword] of modes) {
    if (query !== "原子刻度相关内容") assert.equal(preferKeyword, true);
  }
  assert.equal(response.hits.length, 0);
});

test("retrieve: term_expansion 将结构化词项原样传给 FTS", async () => {
  const termsByQuery = new Map<string, string[] | undefined>();
  const languageByQuery = new Map<string, string | undefined>();
  const engine = createKnowledgeEngine({
    knowledgeTier: "balanced",
    resolveRewrite: async () => ({
      source: "terminology",
      synonyms: ["atomistic", "atomic-scale"],
      exclude: [],
      matchedEntryIds: ["atomistic"],
    }),
    capabilities: {
      embedding: true,
      reranker: false,
      ftsTokenizer: "fts5-multilingual-v1",
      memoryTier: "balanced",
      externalConnectors: { web: true, github: true },
    },
    retriever: {
      async retrieve(query, _scope, options) {
        termsByQuery.set(query, options?.keywordQuery?.terms);
        languageByQuery.set(query, options?.keywordQuery?.languagePrimary);
        return { strategy: options?.preferKeyword ? "keyword" : "hybrid", chunks: [] };
      },
    },
  });

  await engine.retrieve({
    query: "原子尺度",
    scope: { mode: "sources", library: "all" },
  });

  // 每个同义短语是独立 variant，terms 保持完整边界（不再拼成长串）
  assert.deepEqual(termsByQuery.get("atomistic"), ["atomistic"]);
  assert.deepEqual(termsByQuery.get("atomic-scale"), ["atomic-scale"]);
  assert.equal(languageByQuery.get("atomistic"), "en");
});

test("retrieve: 原始短语意图原样传给 FTS", async () => {
  let receivedPhrase: string | undefined;
  const engine = createKnowledgeEngine({
    knowledgeTier: "balanced",
    resolveRewrite: noRewrite,
    capabilities: {
      embedding: true,
      reranker: false,
      ftsTokenizer: "fts5-multilingual-v1",
      memoryTier: "balanced",
      externalConnectors: { web: true, github: true },
    },
    retriever: {
      async retrieve(query, _scope, options) {
        if (query === "Passive Mobs") {
          receivedPhrase = options?.keywordQuery?.phrase;
        }
        return { strategy: "keyword", chunks: [] };
      },
    },
  });

  await engine.retrieve({
    query: "Passive Mobs",
    scope: { mode: "sources", library: "all" },
  });
  assert.equal(receivedPhrase, "Passive Mobs");
});

test("HybridRetriever: displayName 不参与召回或绕过向量阈值", async () => {
  const { HybridRetriever } = await import(
    "../../services/knowledge/retriever"
  );
  const retriever = new HybridRetriever(
    {
      dimension: 2,
      modelName: "fake-multilingual",
      async isAvailable() { return true; },
      async embed() { return new Float32Array([1, 0]); },
      async embedBatch() { return [new Float32Array([1, 0])]; },
    },
    {
      keywordIndex: {
        async searchDetailed() {
          return { available: true, candidates: [], chunks: [] };
        },
      } as never,
      vectorIndex: {
        async search() {
          return [
            {
              chunkId: "weak-title-hit",
              documentId: "d1",
              documentName: "原子尺度表征.pdf",
              content: "unrelated numeric table",
              pageNumber: 26,
              position: 0,
              source: "library" as const,
              score: 0.7,
            },
          ];
        },
      } as never,
    },
  );

  const result = await retriever.retrieve(
    "原子刻度",
    { mode: "sources", library: "all" },
    { topK: 8, preferKeyword: false },
  );
  assert.equal(result.chunks.length, 0);
});

test("keyword retriever 路径：无 embedder 时按关键词排序", async () => {
  const { HybridRetriever } = await import(
    "../../services/knowledge/retriever"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/retrieval/keyword/search")) {
      return new Response(
        JSON.stringify({ strategy: "fts_unavailable", chunks: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        chunks: [
          {
            id: "1",
            documentId: "d",
            documentName: "a.md",
            pageNumber: 1,
            position: 0,
            content: "无关内容",
            source: "library",
          },
          {
            id: "2",
            documentId: "d",
            documentName: "a.md",
            pageNumber: 2,
            position: 0,
            content: "本地知识引擎 Knowledge Engine",
            source: "library",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const retriever = new HybridRetriever(null);
    const result = await retriever.retrieve(
      "知识引擎",
      { mode: "sources", library: "all" },
      { topK: 5 },
    );
    assert.equal(result.strategy, "keyword");
    assert.equal(result.chunks[0]?.id, "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keyword retriever 路径：FTS5 候选召回不再拉全量", async () => {
  const { HybridRetriever } = await import(
    "../../services/knowledge/retriever"
  );

  const originalFetch = globalThis.fetch;
  let sawChunksQuery = false;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/retrieval/chunks/query")) {
      sawChunksQuery = true;
    }
    if (url.includes("/retrieval/keyword/search")) {
      return new Response(
        JSON.stringify({
          strategy: "fts5",
          chunks: [
            {
              id: "2",
              documentId: "d",
              documentName: "a.md",
              pageNumber: 2,
              position: 0,
              content: "本地知识引擎",
              source: "library",
              score: 3,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ chunks: [] }), { status: 200 });
  };

  try {
    const retriever = new HybridRetriever(null);
    const result = await retriever.retrieve(
      "知识引擎",
      { mode: "sources", library: "all" },
      { topK: 5 },
    );
    assert.equal(result.strategy, "keyword");
    assert.equal(result.chunks[0]?.id, "2");
    assert.equal(sawChunksQuery, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
