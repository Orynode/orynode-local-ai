/**
 * POST /api/knowledge/v1/export — 代理到 Node data-service
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../config/defaults";
import { lanDeniedResponse } from "../../../../../services/platform";

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/knowledge/export`, {
      method: "POST",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    });
    const body = await response.json().catch(() => ({}));
    return Response.json(
      { apiVersion: "v1", ...body },
      { status: response.status },
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "导出失败",
        code: "export_failed",
      },
      { status: 502 },
    );
  }
}
