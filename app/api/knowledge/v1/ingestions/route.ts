/**
 * POST /api/knowledge/v1/ingestions
 */

import { z } from "zod";
import {
  MAX_KNOWLEDGE_FILE_SIZE,
} from "../../../../../config/defaults";
import { ingestDocument } from "../../../../../services/knowledge";
import { requireLanAccess } from "../../../../../services/platform";

const metaSchema = z.object({
  fileName: z.string().optional(),
  displayName: z.string().optional(),
  contentType: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export async function POST(request: Request) {
  const access = requireLanAccess(request);
  if (!access.ok) {
    return Response.json(
      { error: access.error, code: access.code },
      { status: access.status },
    );
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return Response.json(
        {
          error: "请以 application/octet-stream 上传文件字节",
          code: "unsupported_media",
        },
        { status: 415 },
      );
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_KNOWLEDGE_FILE_SIZE) {
      return Response.json(
        { error: "文件不能超过 50 MB", code: "payload_too_large" },
        { status: 413 },
      );
    }

    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_KNOWLEDGE_FILE_SIZE) {
      return Response.json(
        { error: "文件不能超过 50 MB", code: "payload_too_large" },
        { status: 413 },
      );
    }

    const meta = metaSchema.parse({
      fileName: request.headers.get("x-file-name") || undefined,
      displayName: request.headers.get("x-display-name") || undefined,
      contentType: request.headers.get("content-type") || undefined,
      idempotencyKey: request.headers.get("idempotency-key") || undefined,
    });

    const result = await ingestDocument({
      bytes: buffer,
      fileName: meta.fileName,
      displayName: meta.displayName,
      contentType: meta.contentType,
      target: { namespace: "library" },
    });

    if (result.namespace !== "library") {
      return Response.json(
        { error: "资料导入失败", code: "ingest_failed" },
        { status: 500 },
      );
    }

    return Response.json(
      {
        apiVersion: "v1",
        ingestion: {
          documentId: result.document.id,
          namespace: "library",
          status: result.document.status,
          deduplicated: result.deduplicated,
          jobId: result.jobId ?? null,
          idempotencyKey: meta.idempotencyKey ?? null,
        },
        document: result.document,
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
    return Response.json(
      {
        error: error instanceof Error ? error.message : "入库失败",
        code: "ingest_failed",
      },
      { status: 502 },
    );
  }
}
