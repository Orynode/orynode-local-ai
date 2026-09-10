/**
 * GET /api/knowledge/[id]/wiki — 文档大纲页（W0 heading extract）
 *
 * 没有编译页时从 chunks 懒编译并落库。不调用大模型。
 */

import {
  createRuntimeServices,
  lanDeniedResponse,
} from "../../../../../services/platform";
import {
  enqueueCompileWikiJob,
  parseWikiCompileForce,
  wikiForceBlocked,
  WIKI_FORCE_CONFIRM_ERROR,
} from "../../../../../services/knowledge/wiki/enqueue-compile";
import { loadOrCompileDocumentMirror } from "../../../../../services/knowledge/wiki/ensure-document-mirror";
import { WikiPersistError } from "../../../../../services/knowledge/wiki/persist";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const page = await loadOrCompileDocumentMirror({
      namespace: "library",
      documentId: id,
    });
    if (!page) {
      return Response.json(
        { error: "还没有可抽取的切片，请等资料处理完成" },
        { status: 409 },
      );
    }
    return Response.json({ page, compiled: true });
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 401) {
      return Response.json(
        { error: "百科存储认证失败，请重启 npm run local" },
        { status: 503 },
      );
    }
    return Response.json({ error: "无法读取大纲页" }, { status: 503 });
  }
}

/**
 * POST /api/knowledge/[id]/wiki — 用户点击后入队 compile_wiki（本机 Gemma 综述）
 */
export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    let posted: unknown = {};
    try {
      posted = await request.json();
    } catch {
      posted = {};
    }
    const { force, confirmForce } = parseWikiCompileForce(posted);
    const outline = await loadOrCompileDocumentMirror({
      namespace: "library",
      documentId: id,
    });
    if (!outline || outline.sections.length === 0) {
      return Response.json(
        { error: "还没有可综述的大纲，请等资料处理完成" },
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
      namespace: "library",
      documentId: id,
      pageId: outline.id,
      title: outline.title,
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
