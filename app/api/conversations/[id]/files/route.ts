/**
 * /api/conversations/[id]/files — 会话附件（不进资料库）
 */

import {
  MAX_KNOWLEDGE_FILE_SIZE,
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../../../../config/defaults";
import { ingestDocument } from "../../../../../services/knowledge";

const dataUrl = ORYNODE_DATA_URL;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id: conversationId } = await context.params;
    if (!conversationId) {
      return Response.json({ error: "conversationId 不能为空" }, { status: 400 });
    }
    const response = await fetch(
      `${dataUrl}/conversation-files?conversationId=${encodeURIComponent(conversationId)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(body, { status: response.status });
    }
    return Response.json(body);
  } catch {
    return Response.json(
      { error: "本地资料库服务尚未启动" },
      { status: 503 },
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id: conversationId } = await context.params;
    if (!conversationId) {
      return Response.json({ error: "conversationId 不能为空" }, { status: 400 });
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_KNOWLEDGE_FILE_SIZE) {
      return Response.json(
        { error: "文件不能超过 50 MB" },
        { status: 413 },
      );
    }

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_KNOWLEDGE_FILE_SIZE) {
      return Response.json(
        { error: "文件不能超过 50 MB" },
        { status: 413 },
      );
    }

    // data-service 要求对话已存在；已删 id 返回 404，不会复活空壳
    const result = await ingestDocument({
      bytes: buffer,
      fileName: request.headers.get("x-file-name"),
      contentType: request.headers.get("content-type"),
      target: { namespace: "conversation", conversationId },
    });
    if (result.namespace !== "conversation") {
      return Response.json({ error: "会话附件上传失败" }, { status: 500 });
    }

    return Response.json({ file: result.file }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "会话附件上传失败，请确认本地服务正在运行";
    const status =
      message.includes("只支持") ? 415
      : message.includes("没有可提取") || message.includes("扫描版") ? 422
      : message.includes("为空") ? 400
      : message.includes("对话不存在") ? 404
      : 503;
    return Response.json({ error: message }, { status });
  }
}
