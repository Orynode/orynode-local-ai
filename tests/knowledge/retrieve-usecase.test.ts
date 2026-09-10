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
import { SEARCH_CONFIG } from "../../config/defaults";

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

/** 单元测试不打本机 data-service 的 Wiki 页 */
const NO_WIKI = {
  loadForScope: async () => null,
  loadForQuery: async () => null,
};

test("buildChatKnowledgeContext: scope none 不检索", async () => {
  let called = 0;
  const engine = createKnowledgeEngine({
    wikiHits: NO_WIKI,
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

test("buildChatKnowledgeContext: 寒暄即使有资料库也不检索", async () => {
  let called = 0;
  const engine = createKnowledgeEngine({
    wikiHits: NO_WIKI,
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      called += 1;
      return { chunks: [], strategy: "keyword" };
    }),
  });
  const result = await buildChatKnowledgeContext(engine, {
    messages: [{ role: "user", content: "你好" }],
    retrievalScope: { mode: "sources", library: "all" },
  });
  assert.equal(result.knowledgePrompt, "");
  assert.equal(result.retrieval, null);
  assert.equal(called, 0);
});

test("buildChatKnowledgeContext: 有命中时组装 context", async () => {
  const engine = createKnowledgeEngine({
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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
    wikiHits: NO_WIKI,
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

test("keyword retriever 路径：明确引用单文档并分析时 0 命中回退顺序读取", async () => {
  const { HybridRetriever } = await import(
    "../../services/knowledge/retriever"
  );

  const originalFetch = globalThis.fetch;
  let chunksQueryBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/retrieval/keyword/search")) {
      return new Response(
        JSON.stringify({ strategy: "fts5", chunks: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/retrieval/chunks/query")) {
      chunksQueryBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          chunks: [
            {
              id: "later",
              documentId: "speech",
              documentName: "2026-08-06口播.txt",
              pageNumber: 2,
              position: 0,
              content: "第二部分",
              source: "library",
            },
            {
              id: "first",
              documentId: "speech",
              documentName: "2026-08-06口播.txt",
              pageNumber: 1,
              position: 0,
              content: "第一部分",
              source: "library",
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
      "分析这个口播，如果我是intel的mac可以用吗",
      {
        mode: "sources",
        library: { documentIds: ["speech"] },
      },
      { topK: 8, preferKeyword: true },
    );
    assert.deepEqual(
      result.chunks.map((chunk) => chunk.id),
      ["first", "later"],
    );
    assert.deepEqual(chunksQueryBody?.library, {
      mode: "documents",
      documentIds: ["speech"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keyword retriever 路径：整库不读取全量，单文件问答有范围内回退", async () => {
  const { HybridRetriever } = await import(
    "../../services/knowledge/retriever"
  );

  const originalFetch = globalThis.fetch;
  let chunksQueryCount = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/retrieval/chunks/query")) chunksQueryCount += 1;
    return new Response(
      JSON.stringify(
        url.includes("/retrieval/keyword/search")
          ? { strategy: "fts5", chunks: [] }
          : {
              chunks: [
                {
                  id: "scoped",
                  documentId: "speech",
                  documentName: "口播.txt",
                  pageNumber: 1,
                  position: 0,
                  content: "最低要求是 Apple 芯片 Mac。",
                  source: "library",
                },
              ],
            },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const retriever = new HybridRetriever(null);
    const allResult = await retriever.retrieve(
      "总结资料库",
      { mode: "sources", library: "all" },
      { preferKeyword: true },
    );
    const qaResult = await retriever.retrieve(
      "这个项目的发布日期是什么",
      {
        mode: "sources",
        library: { documentIds: ["speech"] },
      },
      { preferKeyword: true },
    );
    assert.equal(allResult.chunks.length, 0);
    assert.equal(qaResult.chunks[0]?.id, "scoped");
    assert.equal(qaResult.recallMeta?.fallbackUsed, "scoped_read");
    assert.equal(chunksQueryCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retrieve: document_read 有 Wiki 页时不跑 Retriever", async () => {
  let retrieveCalls = 0;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      retrieveCalls += 1;
      return {
        strategy: "keyword",
        chunks: [
          {
            id: "rag-only",
            documentId: "d1",
            documentName: "手册.md",
            pageNumber: 1,
            position: 0,
            content: "RAG 碎片",
            score: 1,
            source: "library",
          },
        ],
      };
    }),
    wikiHits: {
      loadForScope: async () => [
        {
          id: "mirror:library:d1::synthesis",
          documentId: "d1",
          documentName: "手册.md",
          pageNumber: 1,
          position: 0,
          content: "综述正文",
          score: 3,
          source: "library",
          sourceChunkId: "c1",
        },
        {
          id: "c1",
          documentId: "d1",
          documentName: "手册.md",
          pageNumber: 1,
          position: 1,
          content: "## 安装\n步骤",
          score: 2,
          source: "library",
        },
      ],
    },
  });
  const response = await engine.retrieve({
    query: "这篇讲了什么",
    scope: { mode: "sources", library: { documentIds: ["d1"] } },
    knowledgeTier: "lite",
  });
  assert.equal(retrieveCalls, 0);
  assert.equal(response.diagnostics.accessMode, "document_read");
  assert.equal(response.diagnostics.wikiUsed, true);
  assert.equal(response.diagnostics.fusion, "none");
  assert.ok(response.diagnostics.pipeline?.includes("wiki_document_mirror"));
  assert.deepEqual(response.diagnostics.strategy, ["wiki_document_mirror"]);
  assert.equal(response.hits[0]?.id, "mirror:library:d1::synthesis");
  assert.equal(response.citations[0]?.chunkId, "c1");
  assert.equal(response.hits[1]?.id, "c1");
});

test("search: 概述问句仍跑 Retriever，不走 document_read 短路", async () => {
  let retrieveCalls = 0;
  let queryMode: string | undefined;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      retrieveCalls += 1;
      return {
        strategy: "keyword",
        chunks: [
          {
            id: "rag-only",
            documentId: "d1",
            documentName: "手册.md",
            pageNumber: 1,
            position: 0,
            content: "RAG 碎片",
            score: 1,
            source: "library",
          },
        ],
      };
    }),
    wikiHits: {
      loadForScope: async () => [
        {
          id: "mirror:library:d1::synthesis",
          documentId: "d1",
          documentName: "手册.md",
          pageNumber: 1,
          position: 0,
          content: "综述正文",
          score: 3,
          source: "library",
        },
      ],
      loadForQuery: async (_query, _scope, _topK, _access, options) => {
        queryMode = options?.mode;
        return null;
      },
    },
  });
  const response = await engine.search({
    query: "这篇讲了什么",
    scope: { mode: "sources", library: { documentIds: ["d1"] } },
    knowledgeTier: "lite",
  });
  assert.equal(retrieveCalls, 1);
  assert.notEqual(queryMode, "overview");
  assert.equal(response.diagnostics.accessMode, "library_search");
  assert.equal(response.hits[0]?.id, "rag-only");
});

test("retrieve: 翻译意图即使有 Wiki 仍走 L0", async () => {
  let retrieveCalls = 0;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      retrieveCalls += 1;
      return {
        strategy: "keyword",
        chunks: [
          {
            id: "c1",
            documentId: "d1",
            documentName: "手册.md",
            pageNumber: 1,
            position: 0,
            content: "原文切片要够长才能翻译",
            score: 1,
            source: "library",
          },
        ],
      };
    }),
    wikiHits: {
      loadForScope: async () => {
        throw new Error("翻译不应读取 Wiki 页");
      },
    },
  });
  const response = await engine.retrieve({
    query: "翻译这篇",
    scope: { mode: "sources", library: { documentIds: ["d1"] } },
    knowledgeTier: "lite",
  });
  assert.equal(retrieveCalls, 1);
  assert.equal(response.diagnostics.accessMode, "document_qa");
  assert.equal(response.diagnostics.wikiUsed, false);
  assert.equal(response.hits[0]?.id, "c1");
});

test("retrieve: multi_document 融合 Wiki 图并标记 follow", async () => {
  let retrieveCalls = 0;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      retrieveCalls += 1;
      return {
        strategy: "keyword",
        chunks: [
          {
            id: "rag-1",
            documentId: "d2",
            documentName: "手册 B.md",
            pageNumber: 1,
            position: 0,
            content: "RAG 切片",
            score: 1,
            source: "library",
          },
        ],
      };
    }),
    wikiHits: {
      loadForQuery: async () => ({
        hits: [
          {
            id: "wiki-1",
            documentId: "d1",
            documentName: "手册 A.md",
            pageNumber: 1,
            position: 0,
            content: "Wiki 综述",
            score: 4,
            source: "library",
          },
        ],
        followed: true,
      }),
    },
  });
  const response = await engine.retrieve({
    query: "安装步骤怎么做",
    scope: { mode: "sources", library: { documentIds: ["d1", "d2"] } },
    knowledgeTier: "lite",
  });
  assert.equal(retrieveCalls, 1);
  assert.equal(response.diagnostics.accessMode, "multi_document");
  assert.equal(response.diagnostics.wikiUsed, true);
  assert.equal(response.diagnostics.wikiFollowed, true);
  assert.ok(response.diagnostics.pipeline?.includes("wiki_follow_link"));
  assert.ok(response.diagnostics.pipeline?.includes("wiki_rrf"));
  assert.ok(response.diagnostics.pipeline?.includes("wiki_graph"));
  assert.ok(response.hits.some((hit) => hit.id === "wiki-1"));
  assert.ok(response.hits.some((hit) => hit.id === "rag-1"));
  assert.equal(response.hits[0]?.id, "rag-1");
});

test("retrieve: 工作区概述走编译页预算，不跑 Retriever，也不 dump scope", async () => {
  let retrieveCalls = 0;
  let queryMode: string | undefined;
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => {
      retrieveCalls += 1;
      return {
        strategy: "keyword",
        chunks: [
          {
            id: "rag-only",
            documentId: "d1",
            documentName: "手册.md",
            pageNumber: 1,
            position: 0,
            content: "RAG 碎片",
            score: 1,
            source: "library",
          },
        ],
      };
    }),
    wikiHits: {
      loadForScope: async () => {
        throw new Error("整库概述不得 dump loadForScope");
      },
      loadForQuery: async (_query, _scope, _topK, _access, options) => {
        queryMode = options?.mode;
        return {
          hits: [
            {
              id: "wiki-syn",
              documentId: "d1",
              documentName: "手册.md",
              pageNumber: 1,
              position: 0,
              content: "编译综述",
              score: 4,
              source: "library",
              headingPath: ["综述"],
            },
          ],
          followed: false,
        };
      },
    },
  });
  const response = await engine.retrieve({
    query: "总结资料库",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });
  assert.equal(retrieveCalls, 0);
  assert.equal(queryMode, "overview");
  assert.equal(response.diagnostics.accessMode, "document_read");
  assert.equal(response.diagnostics.wikiUsed, true);
  assert.ok(response.diagnostics.pipeline?.includes("wiki_document_mirror"));
  assert.equal(response.hits[0]?.id, "wiki-syn");
});

test("retrieve: 工作区「zend内存池是什么」原文不被小说 Wiki 挤掉", async () => {
  const engine = createKnowledgeEngine({
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: mockRetriever(() => ({
      strategy: "keyword",
      chunks: [
        {
          id: "php-chunk",
          documentId: "php",
          documentName: "PHP7内核剖析",
          pageNumber: 40,
          position: 0,
          content: "Zend 内存管理器把请求内存交给内存池分配。",
          score: 8,
          source: "library",
        },
      ],
    })),
    wikiHits: {
      loadForQuery: async () => ({
        hits: Array.from({ length: 8 }, (_, index) => ({
          id: `novel-${index}`,
          documentId: "novel",
          documentName: "孤独小说",
          pageNumber: index + 1,
          position: index,
          content: `## 第 ${index + 1} 章目录`,
          score: 9 - index,
          source: "library" as const,
        })),
        followed: false,
      }),
    },
  });
  const response = await engine.retrieve({
    query: "zend内存池是什么",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });
  assert.equal(response.diagnostics.accessMode, "multi_document");
  assert.equal(response.diagnostics.wikiUsed, true);
  assert.equal(response.hits[0]?.id, "php-chunk");
  assert.ok(response.hits.some((hit) => hit.id === "php-chunk"));
});

test("retrieve: 宽召回后词法 rerank 压到 topK", async () => {
  let requestedTopK: number | undefined;
  const filler = Array.from({ length: 11 }, (_, index) => ({
    id: `noise-${index}`,
    documentId: "d1",
    documentName: "手册.md",
    pageNumber: 1,
    position: index,
    content: "无关段落无关键词",
    score: 10 - index * 0.01,
    source: "library" as const,
  }));
  const engine = createKnowledgeEngine({
    wikiHits: NO_WIKI,
    knowledgeTier: "lite",
    resolveRewrite: noRewrite,
    retriever: {
      async retrieve(_query, _scope, options) {
        requestedTopK = options?.topK;
        return {
          strategy: "keyword",
          chunks: [
            ...filler,
            {
              id: "match",
              documentId: "d1",
              documentName: "手册.md",
              pageNumber: 2,
              position: 99,
              content: "先连接电源再打开开关。",
              headingPath: ["部署", "安装步骤"],
              score: 0.1,
              source: "library",
            },
          ],
        };
      },
    },
  });

  const response = await engine.retrieve({
    query: "安装步骤",
    scope: { mode: "sources", library: "all" },
    knowledgeTier: "lite",
  });

  assert.equal(requestedTopK, SEARCH_CONFIG.recallK);
  assert.equal(response.hits.length, SEARCH_CONFIG.topK);
  assert.equal(response.hits[0]?.id, "match");
  assert.ok(response.diagnostics.pipeline?.includes("rerank"));
});
