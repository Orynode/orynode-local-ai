import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../config/defaults";

const dataUrl = ORYNODE_DATA_URL;

async function forward(method: "GET" | "POST" | "DELETE", request?: Request) {
  try {
    const response = await fetch(`${dataUrl}/conversations`, {
      method,
      headers:
        method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? await request?.text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.conversation),
    });
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

export function GET() {
  return forward("GET");
}

export function POST(request: Request) {
  return forward("POST", request);
}

export function DELETE() {
  return forward("DELETE");
}
