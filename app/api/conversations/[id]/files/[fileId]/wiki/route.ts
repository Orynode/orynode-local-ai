/**
 * GET/POST /api/conversations/[id]/files/[fileId]/wiki
 * 会话附件大纲页；综述走 compile_wiki（namespace=conversation）。
 */

import {
  createRuntimeServices,
  lanDeniedResponse,
} from "../../../../../../../services/platform";
import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../../../../../config/defaults";
import { conversationOriginalAccess } from "../../../../../../lib/preview-file-auth";
import {
  enqueueCompileWikiJob,
  parseWikiCompileForce,
  wikiForceBlocked,
  WIKI_FORCE_CONFIRM_ERROR,
} from "../../../../../../../services/knowledge/wiki/enqueue-compile";
import { loadOrCompileDocumentMirror } from "../../../../../../../services/knowledge/wiki/ensure-document-mirror";

type RouteContext = { params: Promise<{ id: string; fileId: string }> };

async function assertConversationFile(input: {
  conversationId: string;
  fileId: string;
}): Promise<Response | null> {
  const metaResponse = await fetch(
    `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(input.fileId)}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    },
  );
  const metaBody = (await metaResponse.json().catch(() => ({}))) as {
    file?: { conversationId?: string };
  };
  const access = conversationOriginalAccess({
    pathConversationId: input.conversationId,
    metaOk: metaResponse.ok,
    metaConversationId: metaBody.file?.conversationId,
  });
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status });
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id: conversationId, fileId } = await context.params;
    if (!conversationId || !fileId) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }
    const blocked = await assertConversationFile({ conversationId, fileId });
    if (blocked) return blocked;
    const page = await loadOrCompileDocumentMirror({
      namespace: "conversation",
      documentId: fileId,
    });
    if (!page) {
      return Response.json(
        { error: "还没有可抽取的切片，请等附件处理完成" },
        { status: 409 },
      );
    }
    return Response.json({ page, compiled: true });
  } catch {
    return Response.json({ error: "无法读取大纲页" }, { status: 503 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id: conversationId, fileId } = await context.params;
    if (!conversationId || !fileId) {
      return Response.json({ error: "参数不完整" }, { status: 400 });
    }
    const blocked = await assertConversationFile({ conversationId, fileId });
    if (blocked) return blocked;
    let posted: unknown = {};
    try {
      posted = await request.json();
    } catch {
      posted = {};
    }
    const { force, confirmForce } = parseWikiCompileForce(posted);
    const outline = await loadOrCompileDocumentMirror({
      namespace: "conversation",
      documentId: fileId,
    });
    if (!outline || outline.sections.length === 0) {
      return Response.json(
        { error: "还没有可综述的大纲，请等附件处理完成" },
        { status: 409 },
      );
    }
    if (wikiForceBlocked(outline, force, confirmForce)) {
      return Response.json(
        { error: WIKI_FORCE_CONFIRM_ERROR },
        { status: 409 },
      );
    }

    const runtime = createRuntimeServices();
    const health = await runtime.model.health();
    if (!health.ok) {
      return Response.json(
        { error: "本地模型还没就绪，综述需要 Gemma 在跑" },
        { status: 503 },
      );
    }

    const job = await enqueueCompileWikiJob({
      namespace: "conversation",
      documentId: fileId,
      pageId: outline.id,
      title: outline.title,
      force,
    });
    return Response.json(job, { status: 202 });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 503
        : 503;
    return Response.json(
      {
        error: error instanceof Error ? error.message : "无法开始生成综述",
      },
      { status },
    );
  }
}
