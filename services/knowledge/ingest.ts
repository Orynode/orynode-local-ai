/**
 * 共享摄取管线：detect → 先存原件 → 按 kind 分轨
 *
 * library：内容哈希身份；显示名仅为元数据；命中哈希则短路不重解析。
 * conversation：不做全局去重。
 * pdf → process_revision；office → convert_office；txt/md → 同步解析 chunk。
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../config/defaults";
import { parseDocument } from "./parser";
import {
  detectKnowledgeKind,
  mimeForKind,
  extensionForKind,
  officeFormatFromFileName,
  KNOWLEDGE_FILE_KIND_LABEL,
  KNOWLEDGE_FILE_KIND_LABEL_NO_OFFICE,
  type KnowledgeFileKind,
} from "./formats";
import { probeOfficeConverterAvailability } from "./adapters/office-probe";
import { createChunker } from "./chunker";
import {
  assignChunkIds,
  commitDocumentChunks,
} from "./indexer";
import {
  hashContent,
  isUsableLibraryDocument,
  resolveDisplayName,
} from "./hash";
import type { ConversationFile, KnowledgeDocument } from "../types";
import type { OcrMode } from "../../config/defaults";

const IN_FLIGHT_JOB = new Set(["queued", "running", "retry_wait"]);
const IN_PROGRESS_DOC = new Set(["processing", "queued", "awaiting_chunks"]);

async function removeIncompleteLibraryDocument(id: string): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // best-effort
  }
}

function takeUsableLibraryHit(
  document: KnowledgeDocument | null | undefined,
): KnowledgeDocument | null {
  if (!document?.id) return null;
  if (isUsableLibraryDocument(document)) return document;
  return null;
}

function processRevisionIdempotencyKey(
  namespace: "library" | "conversation",
  documentId: string,
): string {
  return `process_revision:${namespace}:${documentId}`;
}

function convertOfficeIdempotencyKey(
  namespace: "library" | "conversation",
  documentId: string,
): string {
  return `convert_office:${namespace}:${documentId}`;
}

function processingIdempotencyKey(
  kind: KnowledgeFileKind,
  namespace: "library" | "conversation",
  documentId: string,
): string {
  return kind === "office"
    ? convertOfficeIdempotencyKey(namespace, documentId)
    : processRevisionIdempotencyKey(namespace, documentId);
}

async function lookupJobByIdempotency(
  key: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/jobs/by-idempotency?key=${encodeURIComponent(key)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      job?: { id?: string; status?: string };
    };
    if (!body.job?.id) return null;
    return { id: String(body.job.id), status: String(body.job.status || "") };
  } catch {
    return null;
  }
}

/**
 * 仅安全清理：明确失败且没有运行中任务的文档。
 * processing / queued 视为 in-progress，不得删除。
 */
async function maybeRemoveFailedLibraryDocument(
  hit: KnowledgeDocument,
): Promise<boolean> {
  if (IN_PROGRESS_DOC.has(String(hit.status || ""))) {
    return false;
  }
  if (hit.status !== "processing_error" && hit.status !== "stored") {
    // awaiting_chunks 等：若无在途 Job 才清理
    if (hit.status !== "awaiting_chunks") return false;
  }
  const key = processingIdempotencyKey(
    (hit.fileKind as KnowledgeFileKind) || "pdf",
    "library",
    hit.id,
  );
  const job = await lookupJobByIdempotency(key);
  if (job && IN_FLIGHT_JOB.has(job.status)) {
    return false;
  }
  await removeIncompleteLibraryDocument(hit.id);
  return true;
}

export type IngestTarget =
  | { namespace: "library" }
  | { namespace: "conversation"; conversationId: string };

export type IngestResult =
  | {
      namespace: "library";
      document: KnowledgeDocument;
      deduplicated: boolean;
      jobId?: string;
    }
  | { namespace: "conversation"; file: ConversationFile; jobId?: string };

function decodeFileName(value: string | null | undefined, fallbackExt: string): string {
  const fallback = `未命名.${fallbackExt}`;
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).replace(/[/\\]/g, "_").slice(0, 180);
  } catch {
    return fallback;
  }
}

async function readOcrMode(): Promise<OcrMode> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/settings`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    if (!response.ok) return "auto";
    const body = (await response.json()) as {
      settings?: { ocrMode?: string };
    };
    return body.settings?.ocrMode === "disabled" ? "disabled" : "auto";
  } catch {
    return "auto";
  }
}

async function storeLibraryBytes(input: {
  bytes: ArrayBuffer;
  originalName: string;
  displayName: string;
  contentHash: string;
  kind: string;
}): Promise<{ id: string; document?: KnowledgeDocument; deduplicated?: boolean }> {
  const storeResponse = await fetch(`${ORYNODE_DATA_URL}/knowledge`, {
    method: "POST",
    headers: {
      "content-type": mimeForKind(
        input.kind as KnowledgeFileKind,
        officeFormatFromFileName(input.originalName),
      ),
      "x-file-name": encodeURIComponent(input.originalName),
      "x-display-name": encodeURIComponent(input.displayName),
      "x-content-hash": input.contentHash,
      "x-file-kind": input.kind,
    },
    body: input.bytes,
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
  });
  const storeResult = await storeResponse.json();
  if (storeResponse.status === 409 && storeResult.document) {
    const hit = storeResult.document as KnowledgeDocument;
    const usable = takeUsableLibraryHit(hit);
    if (usable) {
      return { id: usable.id, document: usable, deduplicated: true };
    }
    if (IN_PROGRESS_DOC.has(String(hit.status || ""))) {
      return { id: hit.id, document: hit, deduplicated: true };
    }
    const removed = hit?.id
      ? await maybeRemoveFailedLibraryDocument(hit)
      : false;
    if (!removed && hit?.id) {
      return { id: hit.id, document: hit, deduplicated: true };
    }
    const retry = await fetch(`${ORYNODE_DATA_URL}/knowledge`, {
      method: "POST",
      headers: {
        "content-type": mimeForKind(
          input.kind as KnowledgeFileKind,
          officeFormatFromFileName(input.originalName),
        ),
        "x-file-name": encodeURIComponent(input.originalName),
        "x-display-name": encodeURIComponent(input.displayName),
        "x-content-hash": input.contentHash,
        "x-file-kind": input.kind,
      },
      body: input.bytes,
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    });
    const retryResult = await retry.json();
    if (retry.status === 409 && retryResult.document) {
      const retryHit = retryResult.document as KnowledgeDocument;
      const retryUsable = takeUsableLibraryHit(retryHit);
      if (retryUsable) {
        return {
          id: retryUsable.id,
          document: retryUsable,
          deduplicated: true,
        };
      }
      if (IN_PROGRESS_DOC.has(String(retryHit.status || ""))) {
        return { id: retryHit.id, document: retryHit, deduplicated: true };
      }
    }
    if (!retry.ok) {
      throw new Error(retryResult.error || "资料存储失败");
    }
    return { id: retryResult.document.id as string };
  }
  if (!storeResponse.ok) {
    throw new Error(storeResult.error || "资料存储失败");
  }
  return { id: storeResult.document.id as string };
}

async function enqueueProcessRevision(input: {
  namespace: "library" | "conversation";
  documentId: string;
  ocrMode: OcrMode;
}): Promise<string> {
  const response = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "process_revision",
      idempotencyKey: processRevisionIdempotencyKey(
        input.namespace,
        input.documentId,
      ),
      payload: {
        version: 1,
        namespace: input.namespace,
        documentId: input.documentId,
        ocrMode: input.ocrMode,
      },
      maxAttempts: 3,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "无法排队 OCR/处理任务");
  }
  return String(body.job?.id || body.id || "");
}

async function enqueueConvertOffice(input: {
  namespace: "library" | "conversation";
  documentId: string;
  formatHint?: string | null;
}): Promise<string> {
  const response = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "convert_office",
      idempotencyKey: convertOfficeIdempotencyKey(
        input.namespace,
        input.documentId,
      ),
      payload: {
        schemaVersion: 1,
        namespace: input.namespace,
        documentId: input.documentId,
        formatHint: input.formatHint || undefined,
      },
      maxAttempts: 3,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "无法排队 Office 转换任务");
  }
  return String(body.job?.id || body.id || "");
}

async function enqueueProcessingForKind(input: {
  kind: KnowledgeFileKind;
  namespace: "library" | "conversation";
  documentId: string;
  fileName?: string | null;
}): Promise<string> {
  if (input.kind === "office") {
    return enqueueConvertOffice({
      namespace: input.namespace,
      documentId: input.documentId,
      formatHint: officeFormatFromFileName(input.fileName || ""),
    });
  }
  return enqueueProcessRevision({
    namespace: input.namespace,
    documentId: input.documentId,
    ocrMode: await readOcrMode(),
  });
}

async function setStatus(
  namespace: "library" | "conversation",
  id: string,
  status: string,
  errorMessage?: string | null,
): Promise<KnowledgeDocument | ConversationFile> {
  if (namespace === "library") {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, errorMessage: errorMessage ?? null }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || "更新文档状态失败");
    }
    return body.document as KnowledgeDocument;
  }

  const response = await fetch(
    `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(id)}/status`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, errorMessage: errorMessage ?? null }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "更新附件状态失败");
  }
  return body.file as ConversationFile;
}

async function storeConversationBytes(input: {
  bytes: ArrayBuffer;
  conversationId: string;
  originalName: string;
  kind: string;
}): Promise<string> {
  const storeResponse = await fetch(
    `${ORYNODE_DATA_URL}/conversation-files?conversationId=${encodeURIComponent(input.conversationId)}`,
    {
      method: "POST",
      headers: {
        "content-type": mimeForKind(
          input.kind as KnowledgeFileKind,
          officeFormatFromFileName(input.originalName),
        ),
        "x-file-name": encodeURIComponent(input.originalName),
        "x-file-kind": input.kind,
        "x-conversation-id": input.conversationId,
      },
      body: input.bytes,
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    },
  );
  const storeResult = await storeResponse.json();
  if (!storeResponse.ok) {
    throw new Error(storeResult.error || "会话附件存储失败");
  }
  return storeResult.file.id as string;
}

export async function ingestDocument(options: {
  bytes: ArrayBuffer;
  fileName?: string | null;
  displayName?: string | null;
  contentType?: string | null;
  target: IngestTarget;
}): Promise<IngestResult> {
  const { bytes, target } = options;
  if (bytes.byteLength === 0) {
    throw new Error("文件为空");
  }

  const kind = detectKnowledgeKind({
    fileName: options.fileName ? decodeURIComponent(options.fileName) : null,
    contentType: options.contentType ?? null,
    buffer: bytes,
  });
  if (!kind) {
    throw new Error(KNOWLEDGE_FILE_KIND_LABEL);
  }

  if (kind === "office") {
    const officeConverter = await probeOfficeConverterAvailability();
    if (officeConverter !== "anydoc") {
      throw new Error(KNOWLEDGE_FILE_KIND_LABEL_NO_OFFICE);
    }
  }

  const originalName = decodeFileName(
    options.fileName,
    extensionForKind(kind),
  );
  const displayName = resolveDisplayName(options.displayName, originalName);
  const dataUrl = ORYNODE_DATA_URL;

  if (target.namespace === "library") {
    const contentHash = hashContent(bytes);
    const lookup = await fetch(
      `${dataUrl}/knowledge/by-hash/${encodeURIComponent(contentHash)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (lookup.ok) {
      const body = await lookup.json();
      const hit = body.document as KnowledgeDocument;
      const usable = takeUsableLibraryHit(hit);
      if (usable) {
        return {
          namespace: "library",
          document: usable,
          deduplicated: true,
        };
      }
      // in-progress：幂等复用现有 Job，绝不删除
      if (hit?.id && IN_PROGRESS_DOC.has(String(hit.status || ""))) {
        const jobId = await enqueueProcessingForKind({
          kind: (hit.fileKind as KnowledgeFileKind) || kind,
          namespace: "library",
          documentId: hit.id,
          fileName: options.fileName,
        });
        return {
          namespace: "library",
          document: hit,
          deduplicated: true,
          jobId: jobId || undefined,
        };
      }
      if (hit?.id) {
        await maybeRemoveFailedLibraryDocument(hit);
      }
    }
  }

  // PDF / Office：先存原件，enqueue 对应 Job（分析/转换不在上传 HTTP 内）
  if (kind === "pdf" || kind === "office") {
    let storedId: string | null = null;

    try {
      if (target.namespace === "library") {
        const stored = await storeLibraryBytes({
          bytes,
          originalName,
          displayName,
          contentHash: hashContent(bytes),
          kind,
        });
        if (stored.deduplicated && stored.document) {
          if (isUsableLibraryDocument(stored.document)) {
            return {
              namespace: "library",
              document: stored.document,
              deduplicated: true,
            };
          }
          if (IN_PROGRESS_DOC.has(String(stored.document.status || ""))) {
            const jobId = await enqueueProcessingForKind({
              kind,
              namespace: "library",
              documentId: stored.document.id,
              fileName: originalName,
            });
            return {
              namespace: "library",
              document: stored.document,
              deduplicated: true,
              jobId: jobId || undefined,
            };
          }
        }
        storedId = stored.id;
      } else {
        storedId = await storeConversationBytes({
          bytes,
          conversationId: target.conversationId,
          originalName,
          kind,
        });
      }

      await setStatus(
        target.namespace === "library" ? "library" : "conversation",
        storedId!,
        "processing",
      );
      const jobId = await enqueueProcessingForKind({
        kind,
        namespace: target.namespace === "library" ? "library" : "conversation",
        documentId: storedId!,
        fileName: originalName,
      });
      if (target.namespace === "library") {
        const document = (await setStatus(
          "library",
          storedId!,
          "processing",
        )) as KnowledgeDocument;
        return {
          namespace: "library",
          document,
          deduplicated: false,
          jobId: jobId || undefined,
        };
      }
      const file = (await setStatus(
        "conversation",
        storedId!,
        "processing",
      )) as ConversationFile;
      return { namespace: "conversation", file, jobId: jobId || undefined };
    } catch (error) {
      if (storedId) {
        try {
          await setStatus(
            target.namespace === "library" ? "library" : "conversation",
            storedId,
            "processing_error",
            error instanceof Error ? error.message : "处理失败",
          );
        } catch {
          // ignore
        }
      }
      throw error;
    }
  }

  // TXT / Markdown：同步
  const doc = await parseDocument(bytes, kind);
  const chunker = createChunker();
  const rawChunks = chunker.chunkDocument(doc.pages);
  if (rawChunks.length === 0) {
    throw new Error("文件没有可提取的文字");
  }
  const chunks = assignChunkIds(rawChunks);

  let storedId: string | null = null;
  try {
    if (target.namespace === "library") {
      const stored = await storeLibraryBytes({
        bytes,
        originalName,
        displayName,
        contentHash: hashContent(bytes),
        kind,
      });
      if (stored.deduplicated && stored.document) {
        return {
          namespace: "library",
          document: stored.document,
          deduplicated: true,
        };
      }
      storedId = stored.id;
      const document = (await commitDocumentChunks(
        storedId,
        doc.pageCount,
        chunks,
        "library",
      )) as KnowledgeDocument;
      return { namespace: "library", document, deduplicated: false };
    }

    storedId = await storeConversationBytes({
      bytes,
      conversationId: target.conversationId,
      originalName,
      kind,
    });
    const file = (await commitDocumentChunks(
      storedId,
      doc.pageCount,
      chunks,
      "conversation",
    )) as ConversationFile;
    return { namespace: "conversation", file };
  } catch (error) {
    if (storedId) {
      const path =
        target.namespace === "library"
          ? `${dataUrl}/knowledge/${encodeURIComponent(storedId)}`
          : `${dataUrl}/conversation-files/${encodeURIComponent(storedId)}`;
      try {
        await fetch(path, {
          method: "DELETE",
          signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
        });
      } catch {
        // ignore
      }
    }
    throw error;
  }
}
