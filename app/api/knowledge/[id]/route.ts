/**
 * /api/knowledge/[id] — 删除
 * /api/knowledge/[id]/reindex 见同级 reindex/route.ts
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../config/defaults";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const response = await fetch(
      `${dataUrl}/knowledge/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "无法删除本地资料" }, { status: 503 });
  }
}
