/**
 * POST /api/knowledge/[id]/reindex — 重建单文档向量索引
 */

import { reindexDocument } from "../../../../../services/knowledge";
import { lanDeniedResponse } from "../../../../../services/platform";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const result = await reindexDocument(id);
    return Response.json({ documentId: id, ...result });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "重建向量索引失败",
      },
      { status: 503 },
    );
  }
}
