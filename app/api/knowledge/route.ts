/**
 * /api/knowledge — 入库唯一管线（PDF / TXT / Markdown）
 */

import {
  ORYNODE_DATA_URL,
  MAX_KNOWLEDGE_FILE_SIZE,
  HTTP_TIMEOUT,
  SEARCH_CONFIG,
  EMBEDDING_CONFIG,
} from "../../../config/defaults";
import {
  parseDocument,
  detectKnowledgeKind,
  mimeForKind,
  extensionForKind,
  createChunker,
  assignChunkIds,
  commitDocumentChunks,
  indexDocumentEmbeddings,
} from "../../../services/knowledge";
import type { KnowledgeDocument } from "../../../services/types";

const dataUrl = ORYNODE_DATA_URL;

function decodeFileName(value: string | null, fallbackExt: string): string {
  const fallback = `未命名.${fallbackExt}`;
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).replace(/[/\\]/g, "_").slice(0, 180);
  } catch {
    return fallback;
  }
}

export async function GET() {
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
  let storedId: string | null = null;
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
    if (buffer.byteLength === 0) {
      return Response.json({ error: "文件为空" }, { status: 400 });
    }
    const headerName = request.headers.get("x-file-name");
    const kind = detectKnowledgeKind({
      fileName: headerName ? decodeURIComponent(headerName) : null,
      contentType: request.headers.get("content-type"),
      buffer,
    });
    if (!kind) {
      return Response.json(
        { error: "目前只支持 PDF、TXT、Markdown（.md）文件" },
        { status: 415 },
      );
    }

    const name = decodeFileName(headerName, extensionForKind(kind));
    // parsePdf 内部会拷贝 buffer，调用方的 ArrayBuffer 可安全继续用于落盘
    const doc = await parseDocument(buffer, kind);
    const chunker = createChunker();
    const rawChunks = chunker.chunkDocument(doc.pages);
    if (rawChunks.length === 0) {
      return Response.json(
        {
          error:
            kind === "pdf"
              ? "这个 PDF 没有可提取的文字，扫描版 PDF 暂不支持"
              : "文件没有可提取的文字",
        },
        { status: 422 },
      );
    }
    const chunks = assignChunkIds(rawChunks);

    const storeResponse = await fetch(`${dataUrl}/knowledge`, {
      method: "POST",
      headers: {
        "content-type": mimeForKind(kind),
        "x-file-name": encodeURIComponent(name),
        "x-file-kind": kind,
      },
      body: buffer,
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    });
    const storeResult = await storeResponse.json();
    if (!storeResponse.ok) {
      throw new Error(storeResult.error || "资料存储失败");
    }
    storedId = storeResult.document.id as string;

    const document: KnowledgeDocument = await commitDocumentChunks(
      storedId,
      doc.pageCount,
      chunks,
    );

    // Workers 可能掐断 fire-and-forget；语义开时必须等向量写完。
    // 未开启语义时 indexDocumentEmbeddings 会立刻 skipped。
    const indexResult = await indexDocumentEmbeddings(storedId, chunks);
    const withIndex: KnowledgeDocument = {
      ...document,
      status:
        indexResult.status === "indexed"
          ? "indexed"
          : indexResult.status === "error"
            ? "error"
            : document.status,
      errorMessage:
        indexResult.status === "error"
          ? indexResult.reason ?? "向量索引失败"
          : document.errorMessage ?? null,
    };

    return Response.json({ document: withIndex }, { status: 201 });
  } catch (error) {
    if (storedId) {
      try {
        await fetch(`${dataUrl}/knowledge/${encodeURIComponent(storedId)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
        });
      } catch {
        // ignore cleanup failure
      }
    }
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "资料导入失败，请确认本地资料库服务正在运行",
      },
      { status: 503 },
    );
  }
}
