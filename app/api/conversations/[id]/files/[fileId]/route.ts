/**
 * /api/conversations/[id]/files/[fileId] — 删除会话附件
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../../../../config/defaults";
import { lanDeniedResponse } from "../../../../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = { params: Promise<{ id: string; fileId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id: conversationId, fileId } = await context.params;
    if (!conversationId || !fileId) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }

    const metaResponse = await fetch(
      `${dataUrl}/conversation-files/${encodeURIComponent(fileId)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const metaBody = await metaResponse.json().catch(() => ({}));
    if (!metaResponse.ok) {
      return Response.json(metaBody, { status: metaResponse.status });
    }
    if (metaBody.file?.conversationId !== conversationId) {
      return Response.json({ error: "会话附件不属于该对话" }, { status: 404 });
    }

    const response = await fetch(
      `${dataUrl}/conversation-files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const body = await response.json().catch(() => ({}));
    return Response.json(body, { status: response.status });
  } catch {
    return Response.json(
      { error: "本地资料库服务尚未启动" },
      { status: 503 },
    );
  }
}
