/**
 * GET /api/knowledge/[id]/chunks — 资料库分块列表（调试 / 开放 API）
 *
 * Office 行号预览请用 /indexed-text（IndexedText 坐标系），勿用本接口拼装预览文本。
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
      `${dataUrl}/knowledge/${encodeURIComponent(id)}/chunks`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "无法读取文档分块" }, { status: 503 });
  }
}
