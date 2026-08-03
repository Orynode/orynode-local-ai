/**
 * /api/knowledge/[id] — 删除 / 重命名（仅改显示名，不动内容身份）
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../config/defaults";
import { lanDeniedResponse } from "../../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
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

export async function PATCH(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const response = await fetch(
      `${dataUrl}/knowledge/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: body.name }),
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "无法重命名本地资料" }, { status: 503 });
  }
}
