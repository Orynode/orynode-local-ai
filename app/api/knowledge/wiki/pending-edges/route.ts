/**
 * GET /api/knowledge/wiki/pending-edges?fromId=
 */

import { lanDeniedResponse } from "../../../../../services/platform";
import { listWikiPendingEdges } from "../../../../../services/knowledge/wiki/persist";
import {
  requireReadableWikiPage,
  wikiBrowseContextFromRequest,
  wikiToolErrorResponse,
} from "../../../../../services/knowledge/wiki/wiki-http-access";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const fromId = String(
      new URL(request.url).searchParams.get("fromId") || "",
    ).trim();
    if (!fromId) {
      return Response.json({ error: "缺少 fromId" }, { status: 400 });
    }
    await requireReadableWikiPage(fromId, wikiBrowseContextFromRequest(request));
    const edges = await listWikiPendingEdges(fromId);
    return Response.json({ edges });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取待解析关系" }, { status: 503 })
    );
  }
}
