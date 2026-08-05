/**
 * GET /api/knowledge/v1/jobs — 资料库处理中心 Job 列表
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../../config/defaults";
import { lanDeniedResponse } from "../../../../../services/platform";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;

  try {
    const incoming = new URL(request.url);
    const upstream = new URL(`${ORYNODE_DATA_URL}/jobs`);
    for (const key of [
      "status",
      "type",
      "limit",
      "offset",
      "includeRecent",
    ]) {
      const value = incoming.searchParams.get(key);
      if (value != null && value !== "") {
        upstream.searchParams.set(key, value);
      }
    }
    if (!upstream.searchParams.has("includeRecent")) {
      upstream.searchParams.set("includeRecent", "1");
    }

    const response = await fetch(upstream, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(
        { ...body, apiVersion: "v1", code: "jobs_list_failed" },
        { status: response.status },
      );
    }
    return Response.json({ apiVersion: "v1", ...body });
  } catch {
    return Response.json(
      {
        error: "本地资料库服务尚未启动",
        code: "data_service_unavailable",
      },
      { status: 503 },
    );
  }
}
