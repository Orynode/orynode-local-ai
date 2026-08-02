/**
 * 共享摄取管线：detect → parse → chunk → 落盘 → commit →（可选）embed
 *
 * library：内容哈希身份；显示名仅为元数据；命中哈希则短路不重解析。
 * conversation：不做全局去重。
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
} from "./formats";
import { createChunker } from "./chunker";
import {
  assignChunkIds,
  commitDocumentChunks,
  indexDocumentEmbeddings,
} from "./indexer";
import {
  hashContent,
  isUsableLibraryDocument,
  resolveDisplayName,
} from "./hash";
import type { ConversationFile, KnowledgeDocument } from "../types";

async function removeIncompleteLibraryDocument(id: string): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
  } catch {
    // best-effort：清半成品失败时后续 POST 仍可能 409，再删一次
  }
}

/** 命中哈希但文档未完成分块时删掉半成品，返回 null 以继续完整摄取 */
function takeUsableLibraryHit(
  document: KnowledgeDocument | null | undefined,
): KnowledgeDocument | null {
  if (!document?.id) return null;
  if (isUsableLibraryDocument(document)) return document;
  return null;
}

export type IngestTarget =
  | { namespace: "library" }
  | { namespace: "conversation"; conversationId: string };

export type IngestResult =
  | {
      namespace: "library";
      document: KnowledgeDocument;
      deduplicated: boolean;
    }
  | { namespace: "conversation"; file: ConversationFile };

function decodeFileName(value: string | null | undefined, fallbackExt: string): string {
  const fallback = `未命名.${fallbackExt}`;
  if (!value) return fallback;
  try {
    return decodeURIComponent(value).replace(/[/\\]/g, "_").slice(0, 180);
  } catch {
    return fallback;
  }
}

export async function ingestDocument(options: {
  bytes: ArrayBuffer;
  fileName?: string | null;
  /** 可选显示名；空则使用文件名。不参与去重。 */
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
    throw new Error("目前只支持 PDF、TXT、Markdown（.md）文件");
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
      // 半成品占住 content_hash：删除后重新走完整摄取，避免永久不可检索
      if (hit?.id) await removeIncompleteLibraryDocument(hit.id);
    }
  }

  const doc = await parseDocument(bytes, kind);
  const chunker = createChunker();
  const rawChunks = chunker.chunkDocument(doc.pages);
  if (rawChunks.length === 0) {
    throw new Error(
      kind === "pdf"
        ? "这个 PDF 没有可提取的文字，扫描版 PDF 暂不支持"
        : "文件没有可提取的文字",
    );
  }
  const chunks = assignChunkIds(rawChunks);

  let storedId: string | null = null;

  try {
    if (target.namespace === "library") {
      const contentHash = hashContent(bytes);
      const storeResponse = await fetch(`${dataUrl}/knowledge`, {
        method: "POST",
        headers: {
          "content-type": mimeForKind(kind),
          "x-file-name": encodeURIComponent(originalName),
          "x-display-name": encodeURIComponent(displayName),
          "x-content-hash": contentHash,
          "x-file-kind": kind,
        },
        body: bytes,
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
      });
      const storeResult = await storeResponse.json();
      if (storeResponse.status === 409 && storeResult.document) {
        const hit = storeResult.document as KnowledgeDocument;
        const usable = takeUsableLibraryHit(hit);
        if (usable) {
          return {
            namespace: "library",
            document: usable,
            deduplicated: true,
          };
        }
        if (hit?.id) {
          await removeIncompleteLibraryDocument(hit.id);
          const retry = await fetch(`${dataUrl}/knowledge`, {
            method: "POST",
            headers: {
              "content-type": mimeForKind(kind),
              "x-file-name": encodeURIComponent(originalName),
              "x-display-name": encodeURIComponent(displayName),
              "x-content-hash": contentHash,
              "x-file-kind": kind,
            },
            body: bytes,
            signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
          });
          const retryResult = await retry.json();
          if (retry.status === 409 && retryResult.document) {
            const retryHit = retryResult.document as KnowledgeDocument;
            const retryUsable = takeUsableLibraryHit(retryHit);
            if (retryUsable) {
              return {
                namespace: "library",
                document: retryUsable,
                deduplicated: true,
              };
            }
          }
          if (!retry.ok) {
            throw new Error(retryResult.error || "资料存储失败");
          }
          storedId = retryResult.document.id as string;
        } else {
          throw new Error(storeResult.error || "资料存储失败");
        }
      } else if (!storeResponse.ok) {
        throw new Error(storeResult.error || "资料存储失败");
      } else {
        storedId = storeResult.document.id as string;
      }
      if (!storedId) {
        throw new Error(storeResult.error || "资料存储失败");
      }

      const document = (await commitDocumentChunks(
        storedId,
        doc.pageCount,
        chunks,
        "library",
      )) as KnowledgeDocument;

      const indexResult = await indexDocumentEmbeddings(
        storedId,
        chunks,
        "library",
      );
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
      return {
        namespace: "library",
        document: withIndex,
        deduplicated: false,
      };
    }

    const storeResponse = await fetch(
      `${dataUrl}/conversation-files?conversationId=${encodeURIComponent(target.conversationId)}`,
      {
        method: "POST",
        headers: {
          "content-type": mimeForKind(kind),
          "x-file-name": encodeURIComponent(originalName),
          "x-file-kind": kind,
          "x-conversation-id": target.conversationId,
        },
        body: bytes,
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
      },
    );
    const storeResult = await storeResponse.json();
    if (!storeResponse.ok) {
      throw new Error(storeResult.error || "会话附件存储失败");
    }
    storedId = storeResult.file.id as string;

    const file = (await commitDocumentChunks(
      storedId,
      doc.pageCount,
      chunks,
      "conversation",
    )) as ConversationFile;

    const indexResult = await indexDocumentEmbeddings(
      storedId,
      chunks,
      "conversation",
    );
    const withIndex: ConversationFile = {
      ...file,
      status:
        indexResult.status === "indexed"
          ? "indexed"
          : indexResult.status === "error"
            ? "error"
            : file.status,
      errorMessage:
        indexResult.status === "error"
          ? indexResult.reason ?? "向量索引失败"
          : file.errorMessage ?? null,
    };
    return { namespace: "conversation", file: withIndex };
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
        // ignore cleanup failure
      }
    }
    throw error;
  }
}
