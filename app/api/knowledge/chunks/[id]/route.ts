/**
 * GET /api/knowledge/chunks/:id — Agent knowledge.open（需 Scope）
 *
 * Query:
 *   scope — JSON RetrievalScope（必填）
 *   conversationId — 会话附件归属（可选）
 *
 * 无权与不存在均返回 404，不泄露是否真实存在。
 */

import { KnowledgeError } from "../../../../../services/knowledge/core/errors";
import { createKnowledgeEngine } from "../../../../../services/knowledge/application/engine";
import { lanDeniedResponse } from "../../../../../services/platform";

type Params = { params: Promise<{ id: string }> };

function parseScope(url: URL): unknown {
  const raw = url.searchParams.get("scope");
  if (!raw) return { mode: "none" };
  try {
    return JSON.parse(raw);
  } catch {
    return { mode: "none" };
  }
}

export async function GET(request: Request, { params }: Params) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  const { id } = await params;
  const url = new URL(request.url);
  const scope = parseScope(url);
  const conversationId = url.searchParams.get("conversationId");
  const access = {
    actor: { kind: "local-user" as const, id: "local" },
    conversationId,
  };

  try {
    const engine = createKnowledgeEngine();
    const chunk = await engine.openChunk({ chunkId: id, scope }, access);
    return Response.json({ chunk });
  } catch (error) {
    if (
      error instanceof KnowledgeError &&
      (error.code === "chunk_not_found" ||
        error.code === "chunk_not_in_scope" ||
        error.code === "invalid_scope")
    ) {
      return Response.json(
        { error: "chunk 不可用", chunk: null, code: "not_found" },
        { status: 404 },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: 502 },
    );
  }
}
