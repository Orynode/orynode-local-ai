/**
 * DefaultKnowledgeEngine — Phase 0–4
 *
 * Chat / Agent / 工作台只通过本入口做 search / retrieve / buildContext。
 */

import { z } from "zod";
import { EMBEDDING_CONFIG, type KnowledgeTier } from "../../../config/defaults";
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
import {
  applyLexicalBoost,
  LexicalReranker,
} from "../retrieval/rerank";
import { weightedRrfFusion } from "../retrieval/keyword";
import { buildHighlightTerms } from "../retrieval/highlight-terms";
import type { RetrievalHit, Retriever } from "../types";

const retrievalRequestSchema = z.object({
  query: z.string(),
  scope: z.unknown().optional(),
  topK: z.number().int().positive().max(64).optional(),
  conversationId: z.string().nullable().optional(),
  retrievalScope: z.unknown().optional(),
  knowledgeScope: z.unknown().optional(),
  knowledgeDocumentId: z.string().optional(),
  knowledgeTier: z.enum(["auto", "lite", "balanced", "quality"]).optional(),
});

export type CreateKnowledgeEngineOptions = {
  retriever?: Retriever;
  knowledgeTier?: KnowledgeTier;
  /** 测试或离线注入；缺省运行时探测 */
  capabilities?: import("../retrieval/profile").CapabilitySnapshot;
};

export function createKnowledgeEngine(
  options: CreateKnowledgeEngineOptions = {},
): KnowledgeEngine {
  const retriever = options.retriever ?? new HybridRetriever();
  return new DefaultKnowledgeEngine(
    retriever,
    options.knowledgeTier,
    options.capabilities,
  );
}

class DefaultKnowledgeEngine implements KnowledgeEngine {
  constructor(
    private readonly retriever: Retriever,
    private readonly fixedTier?: KnowledgeTier,
    private readonly fixedCaps?: import("../retrieval/profile").CapabilitySnapshot,
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

  async search(request: SearchRequest): Promise<SearchResponse> {
    const retrieved = await this.retrieve({
      query: request.query,
      scope: request.scope,
      topK: request.topK,
      conversationId: request.conversationId,
      knowledgeTier: (request as { knowledgeTier?: KnowledgeTier }).knowledgeTier,
    });
    return {
      query: retrieved.query,
      hits: retrieved.hits,
      diagnostics: retrieved.diagnostics,
      highlightTerms: retrieved.highlightTerms,
    };
  }

  async retrieve(request: RetrievalRequest & { knowledgeTier?: KnowledgeTier }): Promise<RetrievalResponse> {
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

    const plan = planQuery(request.query, {
      multiQuery: profile.multiQuery,
      embedding: profile.embedding,
      rerank: profile.rerank,
      topK: profile.topK,
    });
    const queries = plan.variants.map((v) => v.text);

    let hits: RetrievalHit[] = [];
    const strategies = new Set<string>();
    const contributingRecallStrategies = new Set<string>();
    let multiQueryFusionApplied = false;
    const pipeline: string[] = ["normalize", "scope_resolve", "query_plan"];
    const multilingualDegraded: string[] = [];
    if (plan.language.primary === "undetermined") {
      multilingualDegraded.push("LANGUAGE_UNDETERMINED");
    }

    try {
      pipeline.push(profile.embedding ? "keyword_vector_recall" : "keyword_recall");
      if (queries.length <= 1) {
        const result = await this.retriever.retrieve(request.query, scope, {
          topK: profile.topK,
          preferKeyword: !profile.embedding,
          keywordQuery: {
            text: request.query,
            terms: plan.searchTerms,
            phrase: plan.phrase,
            exactTerms: plan.exactTerms,
            languagePrimary: plan.language.primary,
          },
        });
        hits = result.chunks;
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
            topK: Math.max(profile.topK * 2, 16),
            // 只有用户原始查询可以做向量召回。normalized/term_expansion
            // 都是词项派生查询；将它们再次向量化会放大宽泛语义候选。
            preferKeyword:
              !profile.embedding || variant.kind !== "original",
            keywordQuery: {
              text: variant.text,
              phrase: variant.kind === "original" ? plan.phrase : undefined,
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
            .slice(0, profile.topK)
            .map(([id, score]) => {
              const hit = byId.get(id)!;
              return { ...hit, score };
            });
          strategies.add("multi_query_rrf");
          multiQueryFusionApplied = true;
        } else if (rankedLists.length === 1) {
          // 只有一条召回列表时没有“融合”可做；保留该索引的真实分数与顺序。
          hits = rankedLists[0]!
            .slice(0, profile.topK)
            .map((id) => byId.get(id))
            .filter((hit): hit is RetrievalHit => Boolean(hit));
        }
      }

      pipeline.push("dedupe");

      if (profile.rerank && hits.length > 1) {
        pipeline.push("rerank");
        const reranker = new LexicalReranker();
        const ranked = reranker.rerankWithMeta(
          request.query,
          hits.map((h) => ({ id: h.id, text: h.content })),
          profile.topK,
        );
        // ADR-ML-005：全零 lexical 不得覆盖融合顺序与分数
        if (ranked.preservedOrder) {
          strategies.add("lexical_rerank_preserved");
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
      }

      pipeline.push("threshold", "context_packing");
    } catch (error) {
      throw new KnowledgeError("retrieval_failed", "检索失败", { cause: error });
    }

    const citations = citationsFromHits(hits);
    const degraded = [...profile.degradedReasons, ...multilingualDegraded];
    if (!strategies.has("hybrid") && profile.embedding) {
      if (
        !degraded.includes("VECTOR_INDEX_NOT_READY") &&
        !degraded.includes("SEMANTIC_RUNTIME_UNAVAILABLE") &&
        !degraded.includes("SEMANTIC_SEARCH_DISABLED")
      ) {
        degraded.push("VECTOR_INDEX_NOT_READY");
      }
    }

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

    const highlightTerms = buildHighlightTerms({
      query: request.query,
      searchTerms: plan.searchTerms,
      exactTerms: plan.exactTerms,
      variants: plan.variants,
    });

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
          hits.length === 0
            ? "none"
            : multiQueryFusionApplied
              ? "weighted_rrf"
              : vectorContributed
                ? "weighted_rrf"
                : "keyword_only",
        embeddingModel: EMBEDDING_CONFIG.artifactId,
        embeddingArtifactRole: EMBEDDING_CONFIG.role,
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

  try {
    const retrieval = await engine.retrieve({
      query,
      scope,
      topK: input.topK,
      conversationId: input.conversationId,
      knowledgeTier: input.knowledgeTier,
    } as RetrievalRequest & { knowledgeTier?: KnowledgeTier });
    if (retrieval.hits.length === 0) {
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
    });
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
