/**
 * POST /api/knowledge/v1/retrieve
 */

import { z } from "zod";
import { SEARCH_CONFIG } from "../../../../../config/defaults";
import { createKnowledgeEngine } from "../../../../../services/knowledge/application/engine";
import { resolveChatRetrievalScope } from "../../../../../services/knowledge/application/resolve-scope";
import { readKnowledgeTierSetting } from "../../../../../services/knowledge/application/capabilities";
import { requireLanAccess } from "../../../../../services/platform";

const bodySchema = z.object({
  query: z.string().min(1),
  scope: z.unknown().optional(),
  retrievalScope: z.unknown().optional(),
  topK: z.number().int().positive().max(64).optional(),
  conversationId: z.string().nullable().optional(),
  knowledgeTier: z.enum(["auto", "lite", "balanced", "quality"]).optional(),
});

export async function POST(request: Request) {
  const access = requireLanAccess(request);
  if (!access.ok) {
    return Response.json(
      { error: access.error, code: access.code },
      { status: access.status },
    );
  }

  try {
    const raw = await request.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "需要非空 query", code: "invalid_scope" },
        { status: 400 },
      );
    }
    const scope = resolveChatRetrievalScope({
      retrievalScope: parsed.data.scope ?? parsed.data.retrievalScope,
      conversationId: parsed.data.conversationId,
    });
    if (scope.mode === "none") {
      return Response.json({
        apiVersion: "v1",
        query: parsed.data.query,
        rewrittenQueries: [],
        hits: [],
        citations: [],
        diagnostics: {
          strategy: [],
          candidateCount: 0,
          elapsedMs: 0,
          degradedCapabilities: ["empty_scope"],
        },
      });
    }

    const tier =
      parsed.data.knowledgeTier ?? (await readKnowledgeTierSetting());
    const engine = createKnowledgeEngine({ knowledgeTier: tier });
    const result = await engine.retrieve({
      query: parsed.data.query,
      scope,
      topK: parsed.data.topK ?? SEARCH_CONFIG.topK,
      conversationId: parsed.data.conversationId,
      knowledgeTier: tier,
    });
    return Response.json({ apiVersion: "v1", ...result });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "检索失败",
        code: "retrieval_failed",
      },
      { status: 502 },
    );
  }
}
