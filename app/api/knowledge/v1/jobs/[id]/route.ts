/**
 * GET /api/knowledge/v1/jobs/:id
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../../config/defaults";
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

  const { id } = await params;
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/jobs/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { ...body, apiVersion: "v1", code: "job_not_found" },
        { status: response.status },
      );
    }
    return Response.json({ apiVersion: "v1", ...body });
  } catch {
    return Response.json(
      { error: "本地资料库服务尚未启动", code: "data_service_unavailable" },
      { status: 503 },
    );
  }
}
