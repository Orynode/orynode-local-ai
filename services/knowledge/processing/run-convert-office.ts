/**
 * convert_office Job 编排
 *
 * 薄管线：heavy lease → 读原件 → OfficeConverter → Markdown 页 → chunk → commit。
 * 与 process_revision（PDF/OCR）分轨；chunk 以下不感知 Office。
 */

import { readFileSync, statSync } from "node:fs";
import {
  OFFICE_CONFIG,
  officeMaxInputBytes,
  type OcrMode,
} from "../../../config/defaults";
import { getDefaultOfficeConverter } from "../adapters/office-anydoc";
import { OfficeConvertError } from "../ports/office-converter";
import { officeFormatFromFileName, resolveKnowledgeFileKind } from "../formats";
import type { OfficeFormat } from "../formats";
import { officeWarningsToErrorMessage } from "../office-contract";
import { parseOfficeMarkdown } from "../parser";
import { createChunker } from "../chunker";
import { assignChunkIds } from "../indexer";

export type ConvertOfficeJobContext = {
  payload: {
    schemaVersion?: number;
    namespace?: string;
    documentId?: string;
    formatHint?: string;
  };
  onProgress?: (progress: Record<string, unknown>) => void;
  deferIfBusy?: boolean;
  getDocumentMeta: (
    namespace: "library" | "conversation",
    documentId: string,
  ) => {
    storedPath?: string | null;
    name?: string | null;
    originalName?: string | null;
    fileKind?: string | null;
  } | null;
  setDocumentStatus: (
    namespace: "library" | "conversation",
    documentId: string,
    status: string,
    extra?: { errorMessage?: string | null; pageCount?: number; chunkCount?: number },
  ) => Promise<void> | void;
  writeIndexedText: (
    namespace: "library" | "conversation",
    documentId: string,
    markdown: string,
  ) => Promise<void> | void;
  commitChunks: (
    namespace: "library" | "conversation",
    documentId: string,
    pageCount: number,
    chunks: Array<{
      id: string;
      pageNumber: number;
      position: number;
      content: string;
      headingPath?: string[];
      startLine?: number;
      endLine?: number;
    }>,
  ) => Promise<unknown> | unknown;
  tryAcquireOffice?: (input: {
    owner: string;
    attemptId: string;
  }) => { ok: true; leaseId: string } | { ok: false; reason: string };
  releaseOffice?: (leaseId: string) => void;
  hostMemoryClass?: "low" | "medium" | "high";
  jobId?: string;
  workerOwner?: string;
};

function mapErrorCode(error: unknown): string {
  if (error instanceof OfficeConvertError) {
    return `OFFICE_${error.code.toUpperCase()}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `OFFICE_FAILED:${message.slice(0, 200)}`;
}

export async function runConvertOfficeJob(
  context: ConvertOfficeJobContext,
): Promise<{ deferred?: boolean; reason?: string; pageCount?: number; chunkCount?: number }> {
  const namespace =
    context.payload.namespace === "conversation" ? "conversation" : "library";
  const documentId = String(context.payload.documentId || "");
  if (!documentId) throw new Error("convert_office 缺少 documentId");

  const owner = context.workerOwner || "convert-office";
  const attemptId = `${context.jobId || documentId}:convert`;

  let leaseId: string | null = null;
  if (typeof context.tryAcquireOffice === "function") {
    const acquire = context.tryAcquireOffice({ owner, attemptId });
    if (!acquire.ok) {
      if (context.deferIfBusy) {
        return { deferred: true, reason: acquire.reason };
      }
      throw new Error(`OFFICE_LEASE_BUSY:${acquire.reason}`);
    }
    leaseId = acquire.leaseId;
  }

  try {
    context.onProgress?.({ phase: "reading", documentId });
    const meta = context.getDocumentMeta(namespace, documentId);
    if (!meta?.storedPath) {
      throw new Error("文档原件不存在");
    }

    const resolvedKind = resolveKnowledgeFileKind({
      fileKind: meta.fileKind,
      paths: [meta.storedPath, meta.originalName, meta.name],
    });
    if (resolvedKind !== "office") {
      throw new Error(
        `CONVERT_OFFICE_WRONG_KIND:${resolvedKind ?? "unknown"}（PDF 请走 process_revision）`,
      );
    }

    const maxBytes = officeMaxInputBytes(context.hostMemoryClass ?? "medium");
    const st = statSync(meta.storedPath);
    if (st.size > maxBytes) {
      throw new OfficeConvertError(
        "ResourceLimit",
        `文件超过 Office 输入上限（${Math.round(maxBytes / (1024 * 1024))}MB）`,
      );
    }

    const bytes = new Uint8Array(readFileSync(meta.storedPath));
    const hintName = String(meta.originalName || meta.name || meta.storedPath);
    const formatHint =
      (context.payload.formatHint as OfficeFormat | undefined) ||
      officeFormatFromFileName(hintName);

    context.onProgress?.({ phase: "converting", formatHint });
    const converter = getDefaultOfficeConverter();
    const converted = await converter.convert(bytes, {
      hint: formatHint,
      budget: {
        timeoutMs: OFFICE_CONFIG.convertTimeoutMs,
        maxOutputChars: OFFICE_CONFIG.maxOutputChars,
        maxSlidesOrSheets: OFFICE_CONFIG.maxSlidesOrSheets,
      },
    });

    context.onProgress?.({ phase: "parsing" });
    if (typeof context.writeIndexedText !== "function") {
      throw new Error(
        "convert_office 缺少 writeIndexedText（IndexedText 契约：预览/行号必须持久化 canonical markdown）",
      );
    }
    await context.writeIndexedText(namespace, documentId, converted.markdown);
    const parsed = parseOfficeMarkdown(converted.markdown, converted.format);
    if (parsed.pageCount === 0 || parsed.pages.length === 0) {
      throw new OfficeConvertError("Malformed", "转换后无可索引文本");
    }

    context.onProgress?.({ phase: "chunking" });
    const chunker = createChunker();
    const rawChunks = chunker.chunkDocument(parsed.pages);
    const chunks = assignChunkIds(rawChunks);

    context.onProgress?.({
      phase: "committing",
      pageCount: parsed.pageCount,
      chunkCount: chunks.length,
    });
    await context.commitChunks(
      namespace,
      documentId,
      parsed.pageCount,
      chunks.map((c) => ({
        id: c.id,
        pageNumber: c.pageNumber,
        position: c.position,
        content: c.content,
        headingPath: c.headingPath,
        startLine: c.startLine,
        endLine: c.endLine,
      })),
    );

    await context.setDocumentStatus(namespace, documentId, "ready", {
      // 与 OCR_PAGE_TRUNCATED 同模式：成功态也可带降级码
      errorMessage: officeWarningsToErrorMessage(converted.warnings),
      pageCount: parsed.pageCount,
      chunkCount: chunks.length,
    });

    return {
      pageCount: parsed.pageCount,
      chunkCount: chunks.length,
    };
  } catch (error) {
    const code = mapErrorCode(error);
    await context.setDocumentStatus(namespace, documentId, "processing_error", {
      errorMessage: code,
    });
    throw error;
  } finally {
    if (leaseId && typeof context.releaseOffice === "function") {
      context.releaseOffice(leaseId);
    }
  }
}

/** 供类型占位；OCR 模式与 Office 无关 */
export type { OcrMode };
