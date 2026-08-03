/**
 * GET /api/knowledge/v1/citations/:id
 * id 为 chunkId；须带 ?scope= JSON
 */

import { createKnowledgeEngine } from "../../../../../../services/knowledge/application/engine";
import { requireLanAccess } from "../../../../../../services/platform";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const access = requireLanAccess(request);
  if (!access.ok) {
    return Response.json(
      { error: access.error, code: access.code },
      { status: access.status },
    );
  }

  const { id: chunkId } = await params;
  const url = new URL(request.url);
  const scopeRaw = url.searchParams.get("scope");
  if (!scopeRaw) {
    return Response.json(
      { error: "需要 scope 查询参数", code: "invalid_scope" },
      { status: 400 },
    );
  }

  let scope: unknown;
  try {
    scope = JSON.parse(scopeRaw);
  } catch {
    return Response.json(
      { error: "scope 必须是 JSON", code: "invalid_scope" },
      { status: 400 },
    );
  }

  try {
    const engine = createKnowledgeEngine({ knowledgeTier: "lite" });
    const resolved = await engine.resolveCitation(
      { chunkId, scope },
      {
        actor: { kind: "local-user", id: "local" },
        conversationId: url.searchParams.get("conversationId"),
      },
    );
    if (!resolved.available) {
      return Response.json(
        { apiVersion: "v1", ...resolved, code: "CHUNK_NOT_IN_SCOPE" },
        { status: 404 },
      );
    }
    return Response.json({ apiVersion: "v1", ...resolved });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "引用解析失败",
        code: "citation_failed",
      },
      { status: 502 },
    );
  }
}
