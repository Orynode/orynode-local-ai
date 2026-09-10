/**
 * POST /api/knowledge/wiki/settle
 * 把本轮回答人手写进一篇大纲页。多源引用不广播；可用 action=undo 回滚。
 */

import { randomUUID } from "node:crypto";
import { lanDeniedResponse } from "../../../../../services/platform";
import {
  fetchWikiPageById,
  listWikiPages,
  saveWikiCandidate,
  saveWikiDecision,
  WikiPersistError,
} from "../../../../../services/knowledge/wiki/persist";
import {
  normalizeSettleTargets,
  settleWikiPages,
  undoWikiSettle,
} from "../../../../../services/knowledge/wiki/run-settle";
import { collapseSettleTargets } from "../../../../../services/knowledge/wiki/settle-plan";
import type { WikiSettleTarget } from "../../../../../services/knowledge/wiki/settle-from-chat";
import type { WikiSettleRequestTarget } from "../../../../../services/knowledge/wiki/run-settle";
import {
  ensureWikiConversationAccess,
  requireReadableWikiPage,
  wikiToolErrorResponse,
  wikiWriteContext,
} from "../../../../../services/knowledge/wiki/wiki-http-access";

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      settleId?: string;
      pageId?: string;
      documentId?: string;
      namespace?: "library" | "conversation";
      markdown?: string;
      conversationId?: string;
      messageId?: string;
      targets?: Array<{
        pageId?: string;
        documentId?: string;
        namespace?: "library" | "conversation";
        title?: string;
      }>;
    };

    if (body.action === "undo") {
      const settleId = String(body.settleId || "").trim();
      const pageId = String(body.pageId || "").trim();
      if (!settleId || !pageId) {
        return Response.json({ error: "缺少可撤销的沉淀" }, { status: 400 });
      }
      const existing = await fetchWikiPageById(pageId);
      if (!existing) {
        return Response.json({ error: "百科页不存在" }, { status: 404 });
      }
      await requireReadableWikiPage(
        existing.id,
        wikiWriteContext({
          namespace:
            existing.namespace === "conversation" ? "conversation" : "library",
          conversationId: body.conversationId,
          fileIds:
            existing.namespace === "conversation"
              ? [existing.sourceDocumentId]
              : [],
        }),
      );
      const page = await undoWikiSettle({ settleId, pageId });
      if (!page) {
        return Response.json({ error: "百科页不存在" }, { status: 404 });
      }
      await saveWikiDecision({
        id: randomUUID(),
        action: "undo",
        actor: "user",
        settleId,
        pageId,
      }).catch(() => null);
      return Response.json({ page, undone: true, settleId });
    }

    const markdown = String(body.markdown || "").trim();
    if (!markdown) {
      return Response.json({ error: "没有可沉淀的正文" }, { status: 400 });
    }
    const rawTargets = normalizeSettleTargets(body);
    if (rawTargets.length === 0) {
      return Response.json({ error: "没有可沉淀的资料引用" }, { status: 400 });
    }

    const explicitPageId = String(body.pageId || "").trim();
    const mapped: WikiSettleTarget[] = [];
    for (const target of rawTargets) {
      const documentId = String(target.documentId || "").trim();
      if (!documentId) continue;
      const namespace: "library" | "conversation" =
        target.namespace === "conversation" ? "conversation" : "library";
      mapped.push({
        documentId,
        namespace,
        title: String(target.title || target.documentId || target.pageId || ""),
      });
    }

    const concepts = await listWikiPages({
      namespace: "library",
      kind: "concept",
      limit: 200,
    });
    const plan = explicitPageId
      ? null
      : collapseSettleTargets({
          targets: mapped.length > 0 ? mapped : [],
          markdown,
          concepts,
        });

    const settleTarget: WikiSettleRequestTarget = explicitPageId
      ? {
          pageId: explicitPageId,
          documentId: String(body.documentId || rawTargets[0]?.documentId || ""),
          namespace:
            body.namespace === "conversation" ? "conversation" : "library",
        }
      : {
          pageId: plan?.target.pageId,
          documentId: plan?.target.documentId,
          namespace: plan?.target.namespace ?? "library",
        };

    if (!settleTarget.pageId && !settleTarget.documentId) {
      return Response.json({ error: "没有可沉淀的资料引用" }, { status: 400 });
    }

    const pendingMerge = Boolean(plan?.pendingMerge);
    const previewId = String(settleTarget.pageId || "").trim();
    if (previewId) {
      const existing = await fetchWikiPageById(previewId);
      if (!existing) {
        return Response.json({ error: "百科页不存在" }, { status: 404 });
      }
      await requireReadableWikiPage(
        existing.id,
        wikiWriteContext({
          namespace:
            existing.namespace === "conversation" ? "conversation" : "library",
          conversationId: body.conversationId,
          fileIds:
            existing.namespace === "conversation"
              ? [existing.sourceDocumentId]
              : [],
        }),
      );
    } else if (settleTarget.namespace === "conversation") {
      const gated = await ensureWikiConversationAccess(
        wikiWriteContext({
          namespace: "conversation",
          conversationId: body.conversationId,
          fileIds: [String(settleTarget.documentId || "")],
        }),
      );
      if (gated.scope.mode === "none") {
        return Response.json({ error: "百科页不存在" }, { status: 404 });
      }
    }

    const settled = await settleWikiPages({
      markdown,
      targets: [settleTarget],
      pendingMerge,
    });
    const first = settled[0];
    if (pendingMerge && first) {
      await saveWikiCandidate({
        id: first.settleId,
        pageId: first.page.id,
        kind: "pending_merge",
        status: "pending",
        text: markdown,
        payload: {
          skippedDocumentIds: plan?.skippedDocumentIds ?? [],
          claimId: plan?.claimId,
          conversationId: body.conversationId,
          messageId: body.messageId,
          mode: plan?.mode,
        },
      });
    }
    return Response.json({
      page: first?.page,
      pages: settled.map((item) => item.page),
      settled,
      pendingMerge,
      settleId: first?.settleId,
      skippedDocumentIds: plan?.skippedDocumentIds ?? [],
    });
  } catch (error) {
    const gated = wikiToolErrorResponse(error);
    if (gated) return gated;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("还没有可沉淀的大纲页")) {
      return Response.json({ error: message }, { status: 409 });
    }
    if (message.includes("百科页不存在")) {
      return Response.json({ error: message }, { status: 404 });
    }
    if (message.includes("过长") || message.includes("已满")) {
      return Response.json({ error: message }, { status: 413 });
    }
    if (error instanceof WikiPersistError && error.op === "save_candidate") {
      return Response.json(
        { error: "已写入百科，但无法登记待审核" },
        { status: 503 },
      );
    }
    return Response.json({ error: "无法写入百科页" }, { status: 503 });
  }
}
