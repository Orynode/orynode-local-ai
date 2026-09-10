/**
 * GET /api/knowledge/wiki/pages/[pageId]/links
 * 走 Agent openPage；?follow=1 时再走 followLink（2 跳硬顶）。
 */

import { lanDeniedResponse } from "../../../../../../../services/platform";
import {
  ensureWikiConversationAccess,
  wikiBrowseContextFromRequest,
  wikiToolErrorResponse,
} from "../../../../../../../services/knowledge/wiki/wiki-http-access";
import {
  knowledgeFollowLink,
  knowledgeOpenPage,
} from "../../../../../../../services/agent/knowledge-tools";

type RouteContext = {
  params: Promise<{ pageId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const id = decodeURIComponent(pageId);
    const url = new URL(request.url);
    const ctx = await ensureWikiConversationAccess(
      wikiBrowseContextFromRequest(request),
    );
    const toolCtx = {
      scope: ctx.scope,
      conversationId: ctx.conversationId,
    };
    const opened = await knowledgeOpenPage(id, toolCtx);
    const follow = url.searchParams.get("follow") === "1";
    const followed = follow
      ? await knowledgeFollowLink(id, toolCtx)
      : [];
    return Response.json({
      outgoing: opened.outgoing,
      incoming: opened.incoming,
      ...(follow ? { followed } : {}),
    });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取百科链接" }, { status: 503 })
    );
  }
}
