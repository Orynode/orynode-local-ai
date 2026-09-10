/**
 * GET /api/knowledge/wiki/pages/[pageId]/history
 * POST — 回滚到某一修订（CAS）
 */

import { lanDeniedResponse } from "../../../../../../../services/platform";
import {
  listWikiRevisions,
  restoreWikiRevision,
  WikiPersistError,
} from "../../../../../../../services/knowledge/wiki/persist";
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
    const revisions = await listWikiRevisions(id);
    return Response.json({ revisions });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取百科历史" }, { status: 503 })
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const id = decodeURIComponent(pageId);
    await requireReadableWikiPage(id, wikiBrowseContextFromRequest(request));
    const body = (await request.json().catch(() => ({}))) as {
      revision?: number;
      ifUpdatedAt?: string;
    };
    const revision = Number(body.revision);
    if (!Number.isFinite(revision) || revision < 1) {
      return Response.json({ error: "缺少 revision" }, { status: 400 });
    }
    const page = await restoreWikiRevision({
      pageId: id,
      revision,
      ifUpdatedAt:
        typeof body.ifUpdatedAt === "string" && body.ifUpdatedAt
          ? body.ifUpdatedAt
          : undefined,
    });
    if (!page) {
      return Response.json({ error: "版本不存在" }, { status: 404 });
    }
    return Response.json({ page });
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 409) {
      return Response.json({ error: "百科页已更新，请重试" }, { status: 409 });
    }
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法回滚百科页" }, { status: 503 })
    );
  }
}
