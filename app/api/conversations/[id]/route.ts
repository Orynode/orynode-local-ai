import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../../config/defaults";
import { lanDeniedResponse } from "../../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function forward(
  method: "GET" | "PUT" | "DELETE",
  request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params;
    const response = await fetch(
      `${dataUrl}/conversations/${encodeURIComponent(id)}`,
      {
        method,
        headers:
          method === "PUT" ? { "content-type": "application/json" } : undefined,
        body: method === "PUT" ? await request.text() : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.conversation),
      },
    );
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return Response.json(
      { error: "本地会话数据库尚未启动" },
      { status: 503 },
    );
  }
}

export function GET(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  return forward("GET", request, context);
}

export function PUT(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  return forward("PUT", request, context);
}

export function DELETE(request: Request, context: RouteContext) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  return forward("DELETE", request, context);
}
