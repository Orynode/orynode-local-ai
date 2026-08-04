/**
 * GET/HEAD /api/knowledge/[id]/file — 资料库原件
 *
 * 鉴权：LAN/本机通过后，仅校验资料存在（不采信客户端 scope 自授权）。
 * HEAD 仅返回头，供预览探测 MIME / 体积，避免拉正文。
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../config/defaults";
import {
  copyPreviewUpstreamHeaders,
  libraryOriginalAccess,
} from "../../../../lib/preview-file-auth";
import { lanDeniedResponse } from "../../../../../services/platform";

type RouteContext = { params: Promise<{ id: string }> };

async function authorizeAndUpstream(
  request: Request,
  context: RouteContext,
  method: "GET" | "HEAD",
) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;

  const { id } = await context.params;
  if (!id) {
    return Response.json({ error: "资料 id 无效" }, { status: 400 });
  }

  const metaResponse = await fetch(
    `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    },
  );
  const access = libraryOriginalAccess(metaResponse.ok);
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }

  const upstream = await fetch(
    `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}/bytes`,
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
