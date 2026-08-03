/**
 * POST /api/knowledge/search — 兼容薄转发（非一等入口）
 *
 * 行为与 POST /api/knowledge/v1/search 相同（共用 runKnowledgeSearch）。
 * 新集成与知识工作台请使用 /api/knowledge/v1/search；本路由不新增独立语义。
 */

import {
  runKnowledgeSearch,
  knowledgeSearchBodySchema,
} from "../../../../services/knowledge/application/run-search";
import { lanDeniedResponse } from "../../../../services/platform";

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const raw = await request.json();
    const parsed = knowledgeSearchBodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "需要非空 query" }, { status: 400 });
    }

    const result = await runKnowledgeSearch(parsed.data);
    const { emptyScope: _empty, ...payload } = result;
    return Response.json(payload, {
      headers: {
        deprecation: "true",
        link: '</api/knowledge/v1/search>; rel="successor-version"',
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "检索失败" },
      { status: 502 },
    );
  }
}
