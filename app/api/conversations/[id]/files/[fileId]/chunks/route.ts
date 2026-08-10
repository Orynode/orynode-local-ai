/**
 * GET /api/conversations/[id]/files/[fileId]/chunks — 会话附件分块列表（调试 / 开放 API）
 *
 * 鉴权：LAN/本机通过后，以附件 conversationId 归属为准。
 * Office 行号预览请用 .../indexed-text，勿用本接口拼装预览文本。
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../../../../../config/defaults";
import { conversationOriginalAccess } from "../../../../../../lib/preview-file-auth";
import { lanDeniedResponse } from "../../../../../../../services/platform";

type RouteContext = { params: Promise<{ id: string; fileId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;

  try {
    const { id: conversationId, fileId } = await context.params;
    if (!conversationId || !fileId) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }

    const metaResponse = await fetch(
      `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeFile),
      },
    );
    const metaBody = (await metaResponse.json().catch(() => ({}))) as {
      file?: { conversationId?: string };
    };
    const access = conversationOriginalAccess({
      pathConversationId: conversationId,
      metaOk: metaResponse.ok,
      metaConversationId: metaBody.file?.conversationId,
    });
    if (!access.ok) {
      return Response.json({ error: access.error }, { status: access.status });
    }

    const upstream = await fetch(
      `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}/chunks`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "无法读取附件分块" }, { status: 503 });
  }
}
