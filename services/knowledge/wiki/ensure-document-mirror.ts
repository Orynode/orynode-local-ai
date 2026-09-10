/**
 * 懒编译 document_mirror：有页就读，没有就从切片抽大纲。不调用 Gemma。
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";
import { compileDocumentMirror } from "./compile-document-mirror";
import {
  fetchWikiPage,
  upsertWikiPage,
  type PersistedWikiPage,
} from "./persist";

type ChunkRow = {
  id?: string;
  content?: string;
  pageNumber?: number;
  position?: number;
  headingPath?: unknown;
  startLine?: number | null;
  endLine?: number | null;
};

export async function loadOrCompileDocumentMirror(input: {
  namespace: "library" | "conversation";
  documentId: string;
}): Promise<PersistedWikiPage | null> {
  const documentId = String(input.documentId || "").trim();
  if (!documentId) return null;
  const existing = await fetchWikiPage({
    namespace: input.namespace,
    sourceDocumentId: documentId,
  });
  if (existing && existing.sections.length > 0) return existing;

  const [title, chunks] = await Promise.all([
    fetchSourceTitle(input.namespace, documentId),
    fetchSourceChunks(input.namespace, documentId),
  ]);
  if (!chunks.length) return existing;
  const page = compileDocumentMirror({
    namespace: input.namespace,
    documentId,
    title: title || documentId,
    chunks,
  });
  try {
    return await upsertWikiPage(page);
  } catch (error) {
    console.warn(
      "[wiki] persist outline failed",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

async function fetchSourceTitle(
  namespace: "library" | "conversation",
  documentId: string,
): Promise<string> {
  const path =
    namespace === "conversation"
      ? `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(documentId)}`
      : `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(documentId)}`;
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  if (!response.ok) return "";
  const body = (await response.json()) as {
    document?: { name?: string };
    file?: { name?: string };
  };
  return String(body.document?.name || body.file?.name || "");
}

async function fetchSourceChunks(
  namespace: "library" | "conversation",
  documentId: string,
): Promise<
  Array<{
    id: string;
    content: string;
    pageNumber: number;
    position: number;
    headingPath?: unknown;
    startLine?: number | null;
    endLine?: number | null;
  }>
> {
  const path =
    namespace === "conversation"
      ? `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(documentId)}/chunks`
      : `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(documentId)}/chunks`;
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { chunks?: ChunkRow[] };
  return (body.chunks ?? []).filter(
    (chunk): chunk is ChunkRow & { id: string; content: string } =>
      Boolean(chunk.id && chunk.content),
  ).map((chunk) => ({
    id: chunk.id,
    content: chunk.content,
    pageNumber: Number(chunk.pageNumber) || 1,
    position: Number(chunk.position) || 0,
    headingPath: chunk.headingPath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }));
}
