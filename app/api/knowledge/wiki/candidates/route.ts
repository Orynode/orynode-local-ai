/**
 * GET /api/knowledge/wiki/candidates?pageId=&status=
 * POST { id, action: accept|reject }
 */

import { lanDeniedResponse } from "../../../../../services/platform";
import {
  getWikiCandidate,
  listWikiCandidates,
} from "../../../../../services/knowledge/wiki/persist";
import { reviewWikiCandidate } from "../../../../../services/knowledge/wiki/run-candidate-review";
import {
  requireReadableWikiPage,
  wikiBrowseContextFromRequest,
  wikiToolErrorResponse,
} from "../../../../../services/knowledge/wiki/wiki-http-access";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const pageId = String(url.searchParams.get("pageId") || "").trim();
    if (!pageId) {
      return Response.json({ error: "缺少 pageId" }, { status: 400 });
    }
    await requireReadableWikiPage(pageId, wikiBrowseContextFromRequest(request));
    const status = String(url.searchParams.get("status") || "").trim();
    const candidates = await listWikiCandidates({
      pageId,
      status: status || undefined,
    });
    return Response.json({ candidates });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取沉淀候选" }, { status: 503 })
    );
  }
}

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      action?: string;
    };
    if (body.action !== "accept" && body.action !== "reject") {
      return Response.json({ error: "缺少有效审核动作" }, { status: 400 });
    }
    const candidate = await getWikiCandidate(String(body.id || ""));
    if (!candidate) {
      return Response.json({ error: "候选不存在" }, { status: 409 });
    }
    await requireReadableWikiPage(
      candidate.pageId,
      wikiBrowseContextFromRequest(request),
    );
    const reviewed = await reviewWikiCandidate({
      id: String(body.id || ""),
      action: body.action,
    });
    return Response.json(reviewed);
  } catch (error) {
    const gated = wikiToolErrorResponse(error);
    if (gated) return gated;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("不存在") || message.includes("已经处理")) {
      return Response.json({ error: message }, { status: 409 });
    }
    if (message.includes("缺少候选")) {
      return Response.json({ error: message }, { status: 400 });
    }
    return Response.json({ error: "无法审核候选" }, { status: 503 });
  }
}
