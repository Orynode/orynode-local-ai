/**
 * /api/knowledge/sources — 薄代理到 data-service
 *
 * Connector（jsdom / octokit）只在 Node data-service 运行；
 * 不得在此文件静态 import connectors，否则 vinext Workers 会因 CJS require 崩溃。
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../../config/defaults";
import { lanDeniedResponse } from "../../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const response = await fetch(`${dataUrl}/sources`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    const body = await response.json().catch(() => ({}));
    return Response.json(body, { status: response.status });
  } catch {
    return Response.json(
      { error: "本地资料库服务尚未启动" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const response = await fetch(`${dataUrl}/sources/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    });
    const result = await response.json().catch(() => ({}));
    return Response.json(result, { status: response.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "来源同步失败";
    return Response.json({ error: message }, { status: 502 });
  }
}
