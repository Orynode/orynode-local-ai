/**
 * GET /api/knowledge/wiki/pages/[pageId]/runs
 */

import { lanDeniedResponse } from "../../../../../../../services/platform";
import { listWikiCompileRuns } from "../../../../../../../services/knowledge/wiki/persist";
import {
  requireReadableWikiPage,
  wikiBrowseContextFromRequest,
  wikiToolErrorResponse,
} from "../../../../../../../services/knowledge/wiki/wiki-http-access";

type RouteContext = {
  params: Promise<{ pageId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const id = decodeURIComponent(pageId);
    await requireReadableWikiPage(id, wikiBrowseContextFromRequest(request));
    const runs = await listWikiCompileRuns(id);
    return Response.json({ runs });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取编译记录" }, { status: 503 })
    );
  }
}
