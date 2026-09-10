/**
 * GET/PATCH /api/knowledge/wiki/pages/[pageId]
 * POST — 按页入队 compile_wiki（文档综述或概念综述）
 *
 * 读路径走 Agent knowledgeOpenPage，必须带 Scope。
 */

import {
  createRuntimeServices,
  lanDeniedResponse,
} from "../../../../../../services/platform";
import {
  enqueueCompileWikiJob,
  parseWikiCompileForce,
  wikiForceBlocked,
  WIKI_FORCE_CONFIRM_ERROR,
} from "../../../../../../services/knowledge/wiki/enqueue-compile";
import { patchWikiPage, WikiPersistError } from "../../../../../../services/knowledge/wiki/persist";
import {
  requireReadableWikiPage,
  wikiBrowseContextFromRequest,
  wikiToolErrorResponse,
} from "../../../../../../services/knowledge/wiki/wiki-http-access";

type RouteContext = {
  params: Promise<{ pageId: string }>;
};

async function openWikiPage(request: Request, pageId: string) {
  return requireReadableWikiPage(pageId, wikiBrowseContextFromRequest(request));
}

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const opened = await openWikiPage(request, decodeURIComponent(pageId));
    return Response.json({
      page: opened.page,
      outgoing: opened.outgoing,
      incoming: opened.incoming,
    });
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 401) {
      return Response.json(
        { error: "百科存储认证失败，请重启 npm run local" },
        { status: 503 },
      );
    }
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法读取百科页" }, { status: 503 })
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const id = decodeURIComponent(pageId);
    await openWikiPage(request, id);
    const body = (await request.json().catch(() => ({}))) as {
      markdown?: string;
      synthesisMarkdown?: string;
    };
    const page = await patchWikiPage(id, {
      ...(typeof body.markdown === "string" ? { markdown: body.markdown } : {}),
      ...(typeof body.synthesisMarkdown === "string"
        ? { synthesisMarkdown: body.synthesisMarkdown }
        : {}),
    });
    if (!page) {
      return Response.json({ error: "百科页不存在" }, { status: 404 });
    }
    return Response.json({ page });
  } catch (error) {
    return (
      wikiToolErrorResponse(error) ??
      Response.json({ error: "无法保存百科修改" }, { status: 503 })
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { pageId } = await context.params;
    const id = decodeURIComponent(pageId);
    let posted: unknown = {};
    try {
      posted = await request.json();
    } catch {
      posted = {};
    }
    const { force, confirmForce } = parseWikiCompileForce(posted);
    const opened = await openWikiPage(request, id);
    const page = opened.page;
    if (wikiForceBlocked(page, force, confirmForce)) {
      return Response.json(
        { error: WIKI_FORCE_CONFIRM_ERROR },
        { status: 409 },
      );
    }
    if (page.sections.length === 0) {
      return Response.json(
        { error: "还没有可综述的大纲，请等资料处理完成" },
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
      namespace: page.namespace,
      documentId: page.sourceDocumentId,
      pageId: page.id,
      title: page.title,
      force,
    });
    return Response.json(job, { status: 202 });
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 401) {
      return Response.json(
        { error: "百科存储认证失败，请重启 npm run local" },
        { status: 503 },
      );
    }
    const gated = wikiToolErrorResponse(error);
    if (gated) return gated;
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
