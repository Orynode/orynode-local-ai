/**
 * GET /api/conversations/[id]/files/[fileId]/indexed-text
 * 会话附件 IndexedText（与 citation 行号同源）
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
      `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}/indexed-text`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const headers = new Headers({
      "content-type":
        upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    const marker = upstream.headers.get("x-orynode-indexed-text");
    if (marker) headers.set("x-orynode-indexed-text", marker);
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers,
    });
  } catch {
    return Response.json({ error: "无法读取附件 IndexedText" }, { status: 503 });
  }
}
