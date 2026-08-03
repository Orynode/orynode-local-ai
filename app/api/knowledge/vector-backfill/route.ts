/**
 * POST /api/knowledge/vector-backfill — 为缺少向量的资料库文档入队补建
 */

import { ensurePendingVectorBackfill } from "../../../../services/knowledge";
import { lanDeniedResponse } from "../../../../services/platform";
import { SEARCH_CONFIG } from "../../../../config/defaults";

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return Response.json({
      enqueued: 0,
      skipped: true,
      reason: "semantic_search_disabled",
    });
  }
  try {
    const result = await ensurePendingVectorBackfill();
    return Response.json(result ?? { enqueued: 0 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "向量补建入队失败",
      },
      { status: 503 },
    );
  }
}
