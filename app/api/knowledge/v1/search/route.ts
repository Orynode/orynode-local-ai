/**
 * POST /api/knowledge/v1/search — 正式 Search 入口（工作台检索预览等）
 */

import {
  knowledgeSearchBodySchema,
  runKnowledgeSearch,
} from "../../../../../services/knowledge/application/run-search";
import {
  lanDeniedResponse,
  sanitizedErrorResponse,
} from "../../../../../services/platform";

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const raw = await request.json();
    const parsed = knowledgeSearchBodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "需要非空 query", code: "invalid_scope" },
        { status: 400 },
      );
    }
    const result = await runKnowledgeSearch(parsed.data);
    const { emptyScope: _empty, ...payload } = result;
    return Response.json({ apiVersion: "v1", ...payload });
  } catch (error) {
    return sanitizedErrorResponse(error, "检索失败", {
      status: 502,
      code: "retrieval_failed",
      logTag: "[knowledge/v1/search]",
    });
  }
}
