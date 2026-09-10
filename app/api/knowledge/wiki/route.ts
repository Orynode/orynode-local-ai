/**
 * GET /api/knowledge/wiki — 列出/搜索百科页
 * POST /api/knowledge/wiki — 用户点击后入队抽取 Job（不跑 Gemma）
 *   { action: "concepts" } 默认：归并概念页
 *   { action: "outlines" }：重抽全部资料大纲
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../../config/defaults";
import { lanDeniedResponse } from "../../../../services/platform";
import { listWikiPages } from "../../../../services/knowledge/wiki/persist";

const dataUrl = ORYNODE_DATA_URL;

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const namespace =
      url.searchParams.get("namespace") === "conversation"
        ? "conversation"
        : "library";
    const conversationId = url.searchParams.get("conversationId")?.trim() || "";
    if (namespace === "conversation" && !conversationId) {
      return Response.json(
        { error: "会话百科列表必须带 conversationId" },
        { status: 400 },
      );
    }
    const pages = await listWikiPages({
      namespace,
      kind: url.searchParams.get("kind") || undefined,
      query: url.searchParams.get("q") || undefined,
      limit: Number(url.searchParams.get("limit") || 40),
      conversationId: namespace === "conversation" ? conversationId : undefined,
    });
    return Response.json({ pages });
  } catch {
    return Response.json({ error: "无法读取百科页" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  let action = "concepts";
  try {
    const posted = (await request.json()) as { action?: string };
    if (posted?.action === "outlines") action = "outlines";
  } catch {
    action = "concepts";
  }
  const outlines = action === "outlines";
  const type = outlines ? "compile_wiki_outlines" : "compile_wiki_concepts";
  const failLabel = outlines ? "无法开始重抽大纲" : "无法开始整理概念";
  try {
    const enqueue = await fetch(`${dataUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        idempotencyKey: `${type}:library`,
        payload: { namespace: "library" },
        maxAttempts: 2,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    const body = (await enqueue.json().catch(() => ({}))) as {
      job?: { id?: string; status?: string };
      error?: string;
    };
    if (!enqueue.ok || !body.job) {
      return Response.json(
        { error: body.error || failLabel },
        { status: enqueue.status === 400 ? 400 : 502 },
      );
    }
    return Response.json(
      { jobId: body.job.id, status: body.job.status },
      { status: 202 },
    );
  } catch {
    return Response.json({ error: failLabel }, { status: 503 });
  }
}
