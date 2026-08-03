/**
 * POST /api/knowledge/[id]/reprocess — 重试 OCR / process_revision
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../config/defaults";
import { lanDeniedResponse } from "../../../../../services/platform";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const response = await fetch(
      `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}/reprocess`,
      {
        method: "POST",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        body.code === "OCR_DISABLED" || body.error === "OCR_DISABLED"
          ? "已关闭扫描识别。可在设置中开启后重试。"
          : typeof body.error === "string"
            ? body.error
            : "重试失败";
      return Response.json({ error: message, code: body.code }, {
        status: response.status,
      });
    }
    return Response.json(body, { status: 202 });
  } catch {
    return Response.json(
      { error: "本地资料库服务尚未启动" },
      { status: 503 },
    );
  }
}
