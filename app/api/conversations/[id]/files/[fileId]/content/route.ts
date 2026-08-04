/**
 * GET/HEAD /api/conversations/[id]/files/[fileId]/content — 会话附件原件
 *
 * 鉴权：LAN/本机通过后，以附件 conversationId 归属为准（不采信客户端 scope）。
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../../../../../config/defaults";
import {
  conversationOriginalAccess,
  copyPreviewUpstreamHeaders,
} from "../../../../../../lib/preview-file-auth";
import { lanDeniedResponse } from "../../../../../../../services/platform";

type RouteContext = { params: Promise<{ id: string; fileId: string }> };

async function authorizeAndUpstream(
  request: Request,
  context: RouteContext,
  method: "GET" | "HEAD",
) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;

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
    `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}/bytes`,
    {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeFile),
    },
  );
  if (!upstream.ok) {
    return Response.json({ error: "原件不存在" }, { status: 404 });
  }

  const headers = copyPreviewUpstreamHeaders(upstream.headers);

  if (method === "HEAD") {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }

  return new Response(upstream.body, { status: 200, headers });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    return await authorizeAndUpstream(request, context, "GET");
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取原件失败" },
      { status: 502 },
    );
  }
}

export async function HEAD(request: Request, context: RouteContext) {
  try {
    return await authorizeAndUpstream(request, context, "HEAD");
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "读取原件失败" },
      { status: 502 },
    );
  }
}
