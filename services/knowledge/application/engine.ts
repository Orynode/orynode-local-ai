/**
 * DefaultKnowledgeEngine — Phase 0–4
 *
 * Chat / Agent / 工作台只通过本入口做 search / retrieve / buildContext。
 */

import { z } from "zod";
import { EMBEDDING_CONFIG, SEARCH_CONFIG, type KnowledgeTier } from "../../../config/defaults";
import { KnowledgeError } from "../core/errors";
import type {
  ContextPackage,
  ContextRequest,
  IngestCommand,
  IngestReceipt,
  ResolvedCitation,
  RetrievalRequest,
  RetrievalResponse,
  SearchRequest,
  SearchResponse,
} from "../core/types";
import { buildContextPackage, citationsFromHits } from "../context/build-context";
import { enrichCitationsWithSourceLocators } from "../context/enrich-citations";
import type { KnowledgeEngine } from "../ports/knowledge-engine";
import { HybridRetriever } from "../retriever";
import { resolveChatRetrievalScope } from "./resolve-scope";
import {
  openChunkInScope,
  resolveCitationInScope,
} from "./open-chunk";
import {
  defaultScopePolicy,
  type KnowledgeAccessContext,
} from "./scope-policy";
import {
  probeCapabilitySnapshot,
  readKnowledgeTierSetting,
} from "./capabilities";
import {
  normalizeDiagnosticStrategies,
  resolveRetrievalProfile,
} from "../retrieval/profile";
import { planQuery } from "../query/planner";
import { applyRewriteExcludes } from "../query/query-rewrite";
import type { StructuredQueryRewrite } from "../query/query-rewrite";
import { resolveQueryRewrite } from "../query/resolve-rewrite";
import { contextualizeChunkText } from "../retrieval/search-text";
import {
  applyLexicalBoost,
  LexicalReranker,
} from "../retrieval/rerank";
import { weightedRrfFusion } from "../retrieval/keyword";
import { buildHighlightTerms } from "../retrieval/highlight-terms";
import type { RetrievalHit, Retriever } from "../types";
import {
  isCasualChatQuery,
  isSingleSourceScope,
  resolveKnowledgeAccessMode,
  scopeSummary,
} from "./access-mode";
import { loadWikiHitsForQuery, loadWikiHitsForScope, mergeWikiRagHits } from "../wiki/load-wiki-hits";
import {
  fetchWikiLinks,
  fetchWikiPageById,
  searchWikiPages,
} from "../wiki/persist";
import { canReadWikiPage } from "../wiki/wiki-access";
import {
  followWikiPages,
  type WikiLink,
  type WikiLinkRel,
  WIKI_FOLLOW_MAX_HOPS,
  WIKI_FOLLOW_MAX_PAGES,
} from "../wiki/wiki-graph";
import type { CompiledWikiPage } from "../wiki/compile-document-mirror";

const retrievalRequestSchema = z.object({
  query: z.string(),
  scope: z.unknown().optional(),
  topK: z.number().int().positive().max(64).optional(),
  conversationId: z.string().nullable().optional(),
  retrievalScope: z.unknown().optional(),
  knowledgeScope: z.unknown().optional(),
  knowledgeDocumentId: z.string().optional(),
  knowledgeTier: z.enum(["auto", "lite", "balanced", "quality"]).optional(),
  surface: z.enum(["search", "chat"]).optional(),
});

export type CreateKnowledgeEngineOptions = {
  retriever?: Retriever;
  knowledgeTier?: KnowledgeTier;
  /** 测试或离线注入；缺省运行时探测 */
  capabilities?: import("../retrieval/profile").CapabilitySnapshot;
  /**
   * 注入 Query Rewrite（测试用）。
   * 缺省走 resolveQueryRewrite（术语库 → LLM → 晋升）。
   */
  resolveRewrite?: (query: string) => Promise<StructuredQueryRewrite>;
  /** 测试注入 Wiki 命中；缺省走 persist */
  wikiHits?: {
    loadForScope?: typeof loadWikiHitsForScope;
    loadForQuery?: typeof loadWikiHitsForQuery;
  };
};

export function createKnowledgeEngine(
  options: CreateKnowledgeEngineOptions = {},
): KnowledgeEngine {
  const retriever = options.retriever ?? new HybridRetriever();
  return new DefaultKnowledgeEngine(
    retriever,
    options.knowledgeTier,
    options.capabilities,
    options.resolveRewrite,
    options.wikiHits,
  );
}

class DefaultKnowledgeEngine implements KnowledgeEngine {
  constructor(
    private readonly retriever: Retriever,
    private readonly fixedTier?: KnowledgeTier,
    private readonly fixedCaps?: import("../retrieval/profile").CapabilitySnapshot,
    private readonly resolveRewriteFn?: (
      query: string,
    ) => Promise<StructuredQueryRewrite>,
    private readonly wikiHits?: CreateKnowledgeEngineOptions["wikiHits"],
  ) {}

  async ingest(command: IngestCommand): Promise<IngestReceipt> {
    const { ingestDocument } = await import("../ingest");
    try {
      if (command.target === "conversation") {
        if (!command.conversationId) {
          throw new KnowledgeError(
            "ingest_failed",
            "conversation ingest 需要 conversationId",
          );
        }
        const result = await ingestDocument({
          target: {
            namespace: "conversation",
            conversationId: command.conversationId,
          },
          bytes: command.bytes,
          fileName: command.fileName,
          displayName: command.displayName,
        });
        if (result.namespace !== "conversation") {
          throw new KnowledgeError("ingest_failed", "会话附件摄取结果异常");
        }
        return {
          documentId: result.file.id,
          namespace: "conversation",
          status: result.file.status ?? "ready",
        };
      }

      const result = await ingestDocument({
        target: { namespace: "library" },
        bytes: command.bytes,
        fileName: command.fileName,
        displayName: command.displayName,
      });
      if (result.namespace !== "library") {
        throw new KnowledgeError("ingest_failed", "资料库摄取结果异常");
      }
      return {
        documentId: result.document.id,
        namespace: "library",
        status: result.document.status ?? "ready",
        reused: result.deduplicated,
      };
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError(
        "ingest_failed",
        error instanceof Error ? error.message : "摄取失败",
        { cause: error },
      );
    }
  }

  async search(
    request: SearchRequest,
    access?: KnowledgeAccessContext,
  ): Promise<SearchResponse> {
    const retrieved = await this.retrieve(
      {
        query: request.query,
        scope: request.scope,
        topK: request.topK,
        conversationId: request.conversationId,
        knowledgeTier: (request as { knowledgeTier?: KnowledgeTier }).knowledgeTier,
        surface: "search",
      },
      access,
    );
    return {
      query: retrieved.query,
      hits: retrieved.hits,
      diagnostics: {
        ...retrieved.diagnostics,
        // Search 产品面只召回、不装箱；勿沿用 Chat 的 accessMode / packing 语义
        accessMode: "library_search",
        contextProvided: false,
        outcome: retrieved.hits.length > 0 ? "search_only" : "empty_hits",
      },
      highlightTerms: retrieved.highlightTerms,
    };
  }

  async retrieve(
    request: RetrievalRequest & { knowledgeTier?: KnowledgeTier },
    access?: KnowledgeAccessContext,
  ): Promise<RetrievalResponse> {
    const started = Date.now();
    const parsed = retrievalRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new KnowledgeError(
        "invalid_scope",
        `无效的检索请求: ${parsed.error.message}`,
      );
    }

    const scope = resolveChatRetrievalScope({
      retrievalScope: request.scope,
      conversationId: request.conversationId,
    });

    const requestedTier =
      request.knowledgeTier ??
      this.fixedTier ??
      (await readKnowledgeTierSetting());
    // 仅测试注入 fixedCaps 时跳过探测；fixedTier 不再 stub embedding:false
    const caps = this.fixedCaps ?? (await probeCapabilitySnapshot());
    const profile = resolveRetrievalProfile(requestedTier, caps, {
      topK: request.topK,
    });
    const recallK = Math.max(profile.topK, SEARCH_CONFIG.recallK);

    const rewrite = this.resolveRewriteFn
      ? await this.resolveRewriteFn(request.query)
      : await resolveQueryRewrite(request.query);
    const plan = planQuery(request.query, {
      multiQuery: profile.multiQuery,
      embedding: profile.embedding,
      rerank: profile.rerank,
      topK: profile.topK,
      rewrite,
    });
    const queries = plan.variants.map((v) => v.text);

    let hits: RetrievalHit[] = [];
    const strategies = new Set<string>();
    const contributingRecallStrategies = new Set<string>();
    let fallbackUsed: "scoped_read" | null = null;
    let multiQueryFusionApplied = false;
    const pipeline: string[] = ["normalize", "scope_resolve", "query_plan"];
    if (rewrite.source === "llm") {
      pipeline.push("query_rewrite_llm");
      strategies.add("query_rewrite_llm");
    } else if (rewrite.source === "terminology") {
      pipeline.push("query_rewrite_cache");
      strategies.add("query_rewrite_cache");
    }
    const multilingualDegraded: string[] = [];
    if (plan.language.primary === "undetermined") {
      multilingualDegraded.push("LANGUAGE_UNDETERMINED");
    }

    const chatAccessMode = resolveKnowledgeAccessMode(scope, request.query);
    const searchSurface = parsed.data.surface === "search";
    const accessMode = searchSurface ? "library_search" : chatAccessMode;
    const wikiAccess: KnowledgeAccessContext = access ?? {
      actor: { kind: "local-user", id: "local" },
      conversationId: request.conversationId,
    };
    const loadWikiForScope =
      this.wikiHits?.loadForScope ?? loadWikiHitsForScope;
    const loadWikiForQuery =
      this.wikiHits?.loadForQuery ?? loadWikiHitsForQuery;
    let wikiUsed = false;
    let wikiFollowed = false;
    let skipRetriever = false;

    if (!searchSurface && chatAccessMode === "document_read") {
      if (isSingleSourceScope(scope)) {
        const wikiHits = await loadWikiForScope(scope, profile.topK);
        if (wikiHits && wikiHits.length > 0) {
          hits = wikiHits;
          wikiUsed = true;
          skipRetriever = true;
          strategies.add("wiki_document_mirror");
          pipeline.push("wiki_document_mirror");
        }
      } else {
        const wikiQuery = await loadWikiForQuery(
          request.query,
          scope,
          profile.topK,
          wikiAccess,
          {
            synonyms: rewrite.synonyms,
            searchTerms: plan.searchTerms,
            mode: "overview",
          },
        );
        if (wikiQuery && wikiQuery.hits.length > 0) {
          hits = wikiQuery.hits;
          wikiUsed = true;
          skipRetriever = true;
          strategies.add("wiki_document_mirror");
          pipeline.push("wiki_document_mirror");
          if (wikiQuery.followed) {
            wikiFollowed = true;
            strategies.add("wiki_follow_link");
            pipeline.push("wiki_follow_link");
          }
        }
      }
    }

    if (!skipRetriever) {
      try {
      pipeline.push(profile.embedding ? "keyword_vector_recall" : "keyword_recall");
      if (queries.length <= 1) {
        const result = await this.retriever.retrieve(request.query, scope, {
          topK: recallK,
          preferKeyword: !profile.embedding,
          keywordQuery: {
            text: request.query,
            terms: plan.searchTerms,
            phrase: plan.phrase,
            queryClass: plan.queryClass,
            lexicalLadder: plan.lexicalLadder,
            exactTerms: plan.exactTerms,
            languagePrimary: plan.language.primary,
          },
        });
        hits = result.chunks;
        fallbackUsed = result.recallMeta?.fallbackUsed ?? null;
        strategies.add(result.strategy);
        if (result.chunks.length > 0) {
          contributingRecallStrategies.add(result.strategy);
        }
      } else {
        const rankedLists: string[][] = [];
        const weights: number[] = [];
        const byId = new Map<string, RetrievalHit>();
        for (const variant of plan.variants) {
          const result = await this.retriever.retrieve(variant.text, scope, {
            topK: Math.max(recallK, profile.topK * 2, 16),
            // 只有用户原始查询可以做向量召回。normalized/term_expansion
            // 都是词项派生查询；将它们再次向量化会放大宽泛语义候选。
            preferKeyword:
              !profile.embedding || variant.kind !== "original",
            keywordQuery: {
              text: variant.text,
              phrase:
                variant.kind === "original"
                  ? plan.phrase
                  : variant.phrase,
              queryClass:
                variant.kind === "original"
                  ? plan.queryClass
                  : variant.queryClass,
              lexicalLadder:
                variant.kind === "original"
                  ? plan.lexicalLadder
                  : variant.lexicalLadder,
              terms:
                variant.kind === "original"
                  ? plan.searchTerms
                  : variant.terms,
              exactTerms:
                variant.kind === "original" ? plan.exactTerms : undefined,
              languagePrimary: variant.language,
            },
          });
          strategies.add(result.strategy);
          fallbackUsed =
            result.recallMeta?.fallbackUsed ?? fallbackUsed;
          if (result.chunks.length > 0) {
            contributingRecallStrategies.add(result.strategy);
            rankedLists.push(result.chunks.map((c) => c.id));
            weights.push(variant.weight);
          }
          for (const chunk of result.chunks) {
            const prev = byId.get(chunk.id);
            if (!prev || chunk.score > prev.score) byId.set(chunk.id, chunk);
          }
        }
        if (rankedLists.length > 1) {
          pipeline.push("weighted_rrf_fusion");
          const fused = weightedRrfFusion(rankedLists, weights);
          hits = [...fused.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, recallK)
            .map(([id, score]) => {
              const hit = byId.get(id)!;
              return { ...hit, score };
            });
          strategies.add("multi_query_rrf");
          multiQueryFusionApplied = true;
        } else if (rankedLists.length === 1) {
          // 只有一条召回列表时没有“融合”可做；保留该索引的真实分数与顺序。
          hits = rankedLists[0]!
            .slice(0, recallK)
            .map((id) => byId.get(id))
            .filter((hit): hit is RetrievalHit => Boolean(hit));
        }
      }

      if (plan.rewrite.exclude.length > 0) {
        const positives = [
          request.query,
          ...(plan.rewrite.synonyms ?? []),
        ];
        const before = hits.length;
        hits = applyRewriteExcludes(hits, positives, plan.rewrite.exclude);
        if (hits.length < before) {
          strategies.add("rewrite_exclude");
          pipeline.push("rewrite_exclude");
        }
      }

      pipeline.push("dedupe");

      if (searchSurface || chatAccessMode === "multi_document") {
        const wikiQuery = await loadWikiForQuery(
          request.query,
          scope,
          recallK,
          wikiAccess,
          { synonyms: rewrite.synonyms, searchTerms: plan.searchTerms },
        );
        if (wikiQuery && wikiQuery.hits.length > 0) {
          hits = mergeWikiRagHits(wikiQuery.hits, hits, recallK);
          wikiUsed = true;
          strategies.add("wiki_rrf");
          pipeline.push("wiki_rrf");
          if (wikiQuery.followed) {
            wikiFollowed = true;
            strategies.add("wiki_graph");
            strategies.add("wiki_follow_link");
            pipeline.push("wiki_graph");
            pipeline.push("wiki_follow_link");
          }
        }
      }

      const shouldRerank =
        hits.length > 1 && (hits.length > profile.topK || profile.rerank);
      if (shouldRerank) {
        pipeline.push("rerank");
        const reranker = new LexicalReranker();
        const ranked = reranker.rerankWithMeta(
          request.query,
          hits.map((h) => ({
            id: h.id,
            text: contextualizeChunkText(h.content, h.headingPath),
          })),
          profile.topK,
        );
        // ADR-ML-005：全零 lexical 不得覆盖融合顺序与分数
        if (ranked.preservedOrder) {
          hits = hits.slice(0, profile.topK);
          strategies.add("lexical_rerank_preserved");
        } else if (hits.length > profile.topK) {
          const map = new Map(hits.map((h) => [h.id, h]));
          hits = ranked.items
            .map((row) => {
              const hit = map.get(row.id);
              return hit ?? null;
            })
            .filter((h): h is RetrievalHit => Boolean(h));
          strategies.add("lexical_rerank");
        } else {
          const boosted = applyLexicalBoost(
            hits.map((h) => ({ id: h.id, score: h.score })),
            ranked.items,
          );
          const map = new Map(hits.map((h) => [h.id, h]));
          hits = boosted
            .map((row) => {
              const hit = map.get(row.id);
              return hit ? { ...hit, score: row.score } : null;
            })
            .filter((h): h is RetrievalHit => Boolean(h));
          strategies.add("lexical_rerank");
        }
      } else if (hits.length > profile.topK) {
        hits = hits.slice(0, profile.topK);
      }

      pipeline.push("threshold", "context_packing");
    } catch (error) {
      throw new KnowledgeError("retrieval_failed", "检索失败", { cause: error });
    }
    }

    const highlightTerms = buildHighlightTerms({
      query: request.query,
      searchTerms: plan.searchTerms,
      exactTerms: plan.exactTerms,
      variants: plan.variants,
      synonyms: plan.rewrite.synonyms,
    });

    const citations = citationsFromHits(hits, highlightTerms);
    // 降级原因只来自 profile/capabilities。
    // 禁止：profile.embedding=true 但本轮未跑 hybrid（如 phrase 短路）时
    // 误标 VECTOR_INDEX_NOT_READY——那与页眉「已就绪 · 关键词 + 语义」矛盾。
    const degraded = [...profile.degradedReasons, ...multilingualDegraded];

    let diagnosticStrategies = normalizeDiagnosticStrategies(
      strategies,
      profile,
    );
    const vectorContributed = contributingRecallStrategies.has("hybrid");
    if (!vectorContributed) {
      diagnosticStrategies = diagnosticStrategies.filter(
        (strategy) => strategy !== "vector",
      );
    }
    if (!multiQueryFusionApplied && !vectorContributed) {
      diagnosticStrategies = diagnosticStrategies.filter(
        (strategy) => strategy !== "rrf",
      );
    }
    // 空结果没有可融合/重排的候选，不应仅因配置开启就宣称执行了 RRF。
    if (hits.length === 0) {
      diagnosticStrategies = diagnosticStrategies.filter(
        (strategy) => strategy !== "rrf" && strategy !== "lexical_rerank",
      );
    }
    if (skipRetriever) {
      diagnosticStrategies = diagnosticStrategies.filter(
        (strategy) =>
          strategy === "wiki_document_mirror" ||
          strategy === "wiki_graph" ||
          strategy === "wiki_follow_link",
      );
    }

    return {
      query: request.query,
      rewrittenQueries: queries.filter((q) => q !== request.query.trim()),
      hits,
      citations,
      highlightTerms,
      diagnostics: {
        strategy: diagnosticStrategies,
        candidateCount: hits.length,
        elapsedMs: Date.now() - started,
        degradedCapabilities: degraded,
        degradedReasons: degraded,
        requestedTier: profile.requestedTier,
        effectiveTier: profile.effectiveTier,
        pipeline,
        queryLanguage: plan.language.primary,
        variants: plan.variants.map((v) => ({
          kind: v.kind,
          language: v.language,
          weight: v.weight,
        })),
        fusion:
          hits.length === 0 || skipRetriever
            ? "none"
            : multiQueryFusionApplied
              ? "weighted_rrf"
              : vectorContributed
                ? "weighted_rrf"
                : "keyword_only",
        embeddingModel: EMBEDDING_CONFIG.artifactId,
        embeddingArtifactRole: EMBEDDING_CONFIG.role,
        rewriteSource: rewrite.source,
        accessMode,
        wikiUsed,
        wikiFollowed,
        fallbackUsed,
        // retrieve 只负责召回；Chat 装箱成功后由 buildChatKnowledgeContext 改写为 context_packed
        contextProvided: false,
        outcome: hits.length > 0 ? "search_only" : "empty_hits",
        scopeSummary: scopeSummary(scope),
      },
    };
  }

  async buildContext(request: ContextRequest): Promise<ContextPackage> {
    const base = buildContextPackage(request);
    const citations = await enrichCitationsWithSourceLocators(base.citations);
    return { ...base, citations };
  }

  async openChunk(
    params: { chunkId: string; scope: unknown },
    access: KnowledgeAccessContext,
  ) {
    return openChunkInScope(params, access, defaultScopePolicy);
  }

  async resolveCitation(
    params: { chunkId: string; scope: unknown },
    access: KnowledgeAccessContext,
  ): Promise<ResolvedCitation> {
    return resolveCitationInScope(params, access, defaultScopePolicy);
  }

  async searchPages(
    params: { query: string; scope: unknown; topK?: number },
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]> {
    const scope = await defaultScopePolicy.resolve(params.scope, access);
    if (scope.mode === "none") return [];
    const topK = Math.min(Math.max(params.topK ?? 8, 1), 16);
    const namespaces: Array<"library" | "conversation"> = [];
    if (scope.library) namespaces.push("library");
    if (scope.conversationFiles) namespaces.push("conversation");
    const pages: CompiledWikiPage[] = [];
    const seen = new Set<string>();
    for (const namespace of namespaces) {
      const found = await searchWikiPages({
        query: params.query,
        namespace,
        limit: topK,
        conversationId:
          namespace === "conversation"
            ? scope.conversationFiles?.conversationId
            : undefined,
      });
      for (const page of found) {
        if (seen.has(page.id)) continue;
        if (!(await canReadWikiPage(page, scope, defaultScopePolicy, access))) {
          continue;
        }
        seen.add(page.id);
        pages.push(page);
        if (pages.length >= topK) return pages;
      }
    }
    return pages;
  }

  async openPage(
    params: { pageId: string; scope: unknown },
    access: KnowledgeAccessContext,
  ) {
    const page = await requireReadableWikiPage(params.pageId, params.scope, access);
    const links = await fetchWikiLinks(page.id);
    return {
      page,
      outgoing: links.outgoing,
      incoming: links.incoming,
    };
  }

  async listBacklinks(
    params: { pageId: string; scope: unknown },
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]> {
    const page = await requireReadableWikiPage(params.pageId, params.scope, access);
    const links = await fetchWikiLinks(page.id);
    return loadReadableNeighbors(
      links.incoming.map((link) => link.fromId),
      params.scope,
      access,
    );
  }

  async followLink(
    params: { pageId: string; scope: unknown; rel?: WikiLinkRel },
    access: KnowledgeAccessContext,
  ): Promise<CompiledWikiPage[]> {
    const page = await requireReadableWikiPage(params.pageId, params.scope, access);
    const listed = await fetchWikiLinks(page.id);
    const bag: WikiLink[] = [...listed.outgoing, ...listed.incoming];
    const ids = followWikiPages(page.id, bag, {
      rel: params.rel,
      maxHops: WIKI_FOLLOW_MAX_HOPS,
      maxPages: WIKI_FOLLOW_MAX_PAGES,
    });
    return loadReadableNeighbors(ids, params.scope, access);
  }
}

async function requireReadableWikiPage(
  pageId: string,
  requestedScope: unknown,
  access: KnowledgeAccessContext,
): Promise<CompiledWikiPage> {
  const id = String(pageId || "").trim();
  if (!id) {
    throw new KnowledgeError("page_not_found", "PAGE_NOT_FOUND");
  }
  const scope = await defaultScopePolicy.resolve(requestedScope, access);
  if (scope.mode === "none") {
    throw new KnowledgeError("page_not_in_scope", "PAGE_NOT_IN_SCOPE");
  }
  const page = await fetchWikiPageById(id);
  if (!page) {
    throw new KnowledgeError("page_not_found", "PAGE_NOT_FOUND");
  }
  if (!(await canReadWikiPage(page, scope, defaultScopePolicy, access))) {
    throw new KnowledgeError("page_not_in_scope", "PAGE_NOT_IN_SCOPE");
  }
  return page;
}

async function loadReadableNeighbors(
  ids: string[],
  requestedScope: unknown,
  access: KnowledgeAccessContext,
): Promise<CompiledWikiPage[]> {
  const scope = await defaultScopePolicy.resolve(requestedScope, access);
  const pages: CompiledWikiPage[] = [];
  const seen = new Set<string>();
  for (const pageId of ids) {
    if (seen.has(pageId)) continue;
    const page = await fetchWikiPageById(pageId);
    if (!page) continue;
    if (!(await canReadWikiPage(page, scope, defaultScopePolicy, access))) {
      continue;
    }
    seen.add(page.id);
    pages.push(page);
  }
  return pages;
}

/** Chat 检索失败时注入的诚实降级文案（行为保持与历史一致） */
export const RETRIEVAL_FAILURE_CONTEXT =
  "\n\n（系统：用户已选择本地资料，但本轮检索失败。请正常回答，并说明未能引用所选资料。）\n";

/** Chat 有 scope 但 0 命中时注入的诚实降级文案 */
export const RETRIEVAL_EMPTY_CONTEXT =
  "\n\n（系统：用户已选择本地资料，但本轮检索未命中相关片段。请正常回答，并说明未能引用所选资料；若资料仍在识别/索引中，可提示用户稍后再试。）\n";

/**
 * Chat use case：根据请求解析 scope → retrieve → buildContext。
 */
export async function buildChatKnowledgeContext(
  engine: KnowledgeEngine,
  input: {
    messages: Array<{ role: string; content?: string }>;
    retrievalScope?: unknown;
    knowledgeScope?: unknown;
    knowledgeDocumentId?: string;
    conversationId?: string | null;
    topK?: number;
    knowledgeTier?: KnowledgeTier;
    /** 知识上下文独立 token 预算 */
    knowledgeBudgetTokens?: number;
  },
): Promise<{
  knowledgePrompt: string;
  retrieval: RetrievalResponse | null;
  context: ContextPackage | null;
}> {
  const scope = resolveChatRetrievalScope({
    retrievalScope: input.retrievalScope,
    knowledgeScope: input.knowledgeScope,
    knowledgeDocumentId: input.knowledgeDocumentId,
    conversationId: input.conversationId,
  });

  if (scope.mode === "none") {
    return { knowledgePrompt: "", retrieval: null, context: null };
  }

  const lastUserMessage = [...input.messages]
    .reverse()
    .find((message) => message?.role === "user");
  const query = String(lastUserMessage?.content ?? "");
  if (!query) {
    return { knowledgePrompt: "", retrieval: null, context: null };
  }
  if (isCasualChatQuery(query)) {
    return { knowledgePrompt: "", retrieval: null, context: null };
  }

  try {
    const retrieval = await engine.retrieve(
      {
        query,
        scope,
        topK: input.topK,
        conversationId: input.conversationId,
        knowledgeTier: input.knowledgeTier,
      } as RetrievalRequest & { knowledgeTier?: KnowledgeTier },
      {
        actor: { kind: "local-user", id: "local" },
        conversationId: input.conversationId,
      },
    );
    if (retrieval.hits.length === 0) {
      retrieval.diagnostics.contextProvided = true;
      retrieval.diagnostics.outcome = "empty_hits";
      return {
        knowledgePrompt: RETRIEVAL_EMPTY_CONTEXT,
        retrieval,
        context: null,
      };
    }
    const context = await engine.buildContext({
      hits: retrieval.hits,
      citations: retrieval.citations,
      maxTokens: input.knowledgeBudgetTokens,
      expandNeighbors: true,
      excerptTerms: retrieval.highlightTerms,
    });
    retrieval.diagnostics.contextProvided = context.text.length > 0;
    retrieval.diagnostics.outcome = "context_packed";
    return {
      knowledgePrompt: context.text,
      retrieval,
      context,
    };
  } catch {
    return {
      knowledgePrompt: RETRIEVAL_FAILURE_CONTEXT,
      retrieval: null,
      context: null,
    };
  }
}
