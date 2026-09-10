/**
 * compile_wiki_outlines Job：用户点击后从现有切片重抽全部 document_mirror。
 * 抽取即可，不占用 Gemma，也不重建向量。
 */

import { randomUUID } from "node:crypto";
import { compileAndUpsertDocumentMirror } from "./compile-and-upsert";
import {
  WIKI_COMPILER_ID,
  WIKI_LIBRARY_SCAN_CAP,
  type WikiCompileChunk,
} from "./compile-document-mirror";
import { recordWikiBuild } from "./persist";

export type CompileOutlinesJobResult = {
  deferred?: false;
  buildId: string;
  pageCount: number;
  skipped: number;
  skippedOverCap: number;
  compiler: string;
};

type LibraryDoc = { id: string; name?: string };

export async function runCompileOutlinesJob(context: {
  payload?: Record<string, unknown>;
  jobId?: string;
  onProgress?: (progress: Record<string, unknown>) => void;
  fetchLibraryDocuments?: () => Promise<LibraryDoc[]>;
  fetchChunks?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<WikiCompileChunk[]>;
  compileMirror?: typeof compileAndUpsertDocumentMirror;
  recordBuild?: typeof recordWikiBuild;
}): Promise<CompileOutlinesJobResult> {
  const report = (progress: Record<string, unknown>) => {
    context.onProgress?.({ namespace: "library", ...progress });
  };
  const compileMirror =
    context.compileMirror ??
    ((input) =>
      compileAndUpsertDocumentMirror(input, {
        strict: true,
        enqueueKnowledge: false,
      }));
  const recordBuild = context.recordBuild ?? recordWikiBuild;

  const allDocs = (await context.fetchLibraryDocuments?.()) ?? [];
  const truncated = allDocs.length > WIKI_LIBRARY_SCAN_CAP;
  const docs = allDocs.slice(0, WIKI_LIBRARY_SCAN_CAP);
  report({
    phase: "extracting",
    done: 0,
    total: docs.length,
    scanned: docs.length,
    available: allDocs.length,
    skippedOverCap: truncated ? allDocs.length - docs.length : 0,
  });

  let pageCount = 0;
  let skipped = 0;
  let done = 0;
  for (const doc of docs) {
    done += 1;
    if (!context.fetchChunks) {
      skipped += 1;
      report({ phase: "extracting", done, total: docs.length });
      continue;
    }
    const chunks = await context.fetchChunks({
      namespace: "library",
      documentId: doc.id,
    });
    if (!chunks.length) {
      skipped += 1;
      report({ phase: "extracting", done, total: docs.length });
      continue;
    }
    const page = await compileMirror({
      namespace: "library",
      documentId: doc.id,
      title: String(doc.name || doc.id),
      chunks,
    });
    if (page) pageCount += 1;
    else skipped += 1;
    report({ phase: "extracting", done, total: docs.length });
  }

  const buildId = randomUUID();
  await recordBuild({
    id: buildId,
    namespace: "library",
    compiler: WIKI_COMPILER_ID,
    pageCount,
    linkCount: 0,
  });
  report({ phase: "ready", pageCount, skipped, skippedOverCap: truncated ? allDocs.length - docs.length : 0 });
  return {
    buildId,
    pageCount,
    skipped,
    skippedOverCap: truncated ? allDocs.length - docs.length : 0,
    compiler: WIKI_COMPILER_ID,
  };
}
