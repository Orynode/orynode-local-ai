/**
 * POST /api/conversations/:id/files/:fileId/reindex — 重建会话附件向量
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../../../config/defaults";
import { reindexDocument } from "../../../../../../../services/knowledge";

type RouteContext = {
  params: Promise<{ id: string; fileId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id: conversationId, fileId } = await context.params;
    if (!conversationId || !fileId) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }

    const metaResponse = await fetch(
      `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (!metaResponse.ok) {
      return Response.json({ error: "会话附件不存在" }, { status: 404 });
    }
    const metaBody = await metaResponse.json();
    if (metaBody.file?.conversationId !== conversationId) {
      return Response.json({ error: "会话附件不存在" }, { status: 404 });
    }

    const result = await reindexDocument(fileId, "conversation");
    return Response.json({ fileId, conversationId, ...result });
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
