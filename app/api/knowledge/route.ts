/**
 * /api/knowledge — 持久资料库唯一入库管线（PDF / TXT / Markdown）
 *
 * 身份 = content hash；显示名可选，不参与去重。
 */

import {
  ORYNODE_DATA_URL,
  MAX_KNOWLEDGE_FILE_SIZE,
  HTTP_TIMEOUT,
  SEARCH_CONFIG,
  EMBEDDING_CONFIG,
} from "../../../config/defaults";
import { ingestDocument } from "../../../services/knowledge";
import { lanDeniedResponse } from "../../../services/platform";

const dataUrl = ORYNODE_DATA_URL;

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const response = await fetch(`${dataUrl}/knowledge`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return Response.json(body, { status: response.status });
    }
    return Response.json({
      ...body,
      meta: {
        semanticSearchEnabled: SEARCH_CONFIG.semanticSearchEnabled,
        embeddingModel: EMBEDDING_CONFIG.modelName,
        embeddingDim: EMBEDDING_CONFIG.dimension,
      },
    });
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

    const result = await ingestDocument({
      bytes: buffer,
      fileName: request.headers.get("x-file-name"),
      displayName: request.headers.get("x-display-name"),
      contentType: request.headers.get("content-type"),
      target: { namespace: "library" },
    });
    if (result.namespace !== "library") {
      return Response.json({ error: "资料导入失败" }, { status: 500 });
    }

    return Response.json(
      {
        document: result.document,
        deduplicated: result.deduplicated,
        jobId: result.jobId ?? null,
      },
      {
        status: result.deduplicated
          ? 200
          : result.jobId
            ? 202
            : 201,
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "资料导入失败，请确认本地资料库服务正在运行";
    const status =
      message.includes("只支持") ? 415
      : message.includes("OCR_DISABLED") ||
          message.includes("没有可提取") ||
          message.includes("扫描版")
        ? 422
      : message.includes("为空") ? 400
      : 503;
    return Response.json(
      {
        error:
          message === "OCR_DISABLED"
            ? "已关闭扫描 PDF 文字识别。可在设置中开启，或上传带可选中文本的 PDF。"
            : message,
      },
      { status },
    );
  }
}
