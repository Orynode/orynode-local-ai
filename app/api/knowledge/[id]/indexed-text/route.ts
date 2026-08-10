/**
 * GET /api/knowledge/[id]/indexed-text — IndexedText（与 citation 行号同源）
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../config/defaults";
import { lanDeniedResponse } from "../../../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const response = await fetch(
      `${dataUrl}/knowledge/${encodeURIComponent(id)}/indexed-text`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const headers = new Headers({
      "content-type":
        response.headers.get("content-type") || "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    const marker = response.headers.get("x-orynode-indexed-text");
    if (marker) headers.set("x-orynode-indexed-text", marker);
    return new Response(await response.text(), {
      status: response.status,
      headers,
    });
  } catch {
    return Response.json({ error: "无法读取 IndexedText" }, { status: 503 });
  }
}
