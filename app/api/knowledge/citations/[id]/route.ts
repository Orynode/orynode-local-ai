/**
 * GET /api/knowledge/citations/:id — 按 chunk id 解析 Citation（需 Scope）
 *
 * Query: scope（JSON）、conversationId（可选）
 * 无权/不存在均 404。
 */

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
    const resolved = await engine.resolveCitation(
      { chunkId: id, scope },
      access,
    );
    return Response.json(resolved, {
      status: resolved.available ? 200 : 404,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "引用解析失败" },
      { status: 502 },
    );
  }
}
