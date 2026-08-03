/**
 * Knowledge Search HTTP 用例（正式 Search 产品面）
 *
 * 供：
 * - POST /api/knowledge/v1/search（工作台检索预览、公开客户端）
 * - POST /api/knowledge/search（薄兼容转发，不新增行为）
 *
 * 与 Chat RAG 的 retrieve / buildChatKnowledgeContext 共享 Engine 召回；
 * 本用例只暴露 search（hits + diagnostics + highlightTerms）。
 */

import { z } from "zod";
import { SEARCH_CONFIG } from "../../../config/defaults";
import { createKnowledgeEngine } from "./engine";
import { resolveChatRetrievalScope } from "./resolve-scope";
import { readKnowledgeTierSetting } from "./capabilities";
import type { SearchResponse } from "../core/types";

export const knowledgeSearchBodySchema = z.object({
  query: z.string().min(1),
  scope: z.unknown().optional(),
  retrievalScope: z.unknown().optional(),
  topK: z.number().int().positive().max(64).optional(),
  conversationId: z.string().nullable().optional(),
  knowledgeTier: z.enum(["auto", "lite", "balanced", "quality"]).optional(),
});

export type KnowledgeSearchBody = z.infer<typeof knowledgeSearchBodySchema>;

export async function runKnowledgeSearch(
  body: KnowledgeSearchBody,
): Promise<SearchResponse & { emptyScope?: boolean }> {
  const scope = resolveChatRetrievalScope({
    retrievalScope: body.scope ?? body.retrievalScope,
    conversationId: body.conversationId,
  });
  if (scope.mode === "none") {
    return {
      query: body.query,
      hits: [],
      diagnostics: {
        strategy: [],
        candidateCount: 0,
        elapsedMs: 0,
        degradedCapabilities: ["empty_scope"],
      },
      emptyScope: true,
    };
  }

  const tier = body.knowledgeTier ?? (await readKnowledgeTierSetting());
  const engine = createKnowledgeEngine({ knowledgeTier: tier });
  return engine.search({
    query: body.query,
    scope,
    topK: body.topK ?? SEARCH_CONFIG.topK,
    conversationId: body.conversationId,
    knowledgeTier: tier,
  });
}
