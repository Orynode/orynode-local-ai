/**
 * process_revision Job 编排（KE-029）
 *
 * 分析 →（按页 checkpoint）OCR/native → chunk/FTS → refs → activate
 * chunks / refs / ProcessingBuild 激活在同一提交路径中原子切换。
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OCR_CONFIG } from "../../../config/defaults";
import type { OcrEngine } from "../../platform/types";
import type { RenderedPageImage } from "./pdf-render";

export type ChunkBlockRef = {
  blockId: string;
  startOffset: number | null;
  endOffset: number | null;
  bboxDegraded?: boolean;
};

export type ChunkBlockMapping = {
  refs: ChunkBlockRef[];
  /** true：无法精确映射，检索侧应仅用 page locator */
  bboxDegraded: boolean;
};

type PageBlockLike = {
  id: string;
  pageNumber: number;
  text: string;
  readingOrder?: number;
  origin?: string;
  bbox?: unknown;
  confidence?: number | null;
  language?: string | null;
};

type DocumentBlocksStore = {
  markPageCheckpoint?: (
    processingBuildId: string,
    pageNumber: number,
    input: { decision: string; status: string },
  ) => void;
  listCheckpointPages?: (processingBuildId: string) => number[];
  listBlocks: (processingBuildId: string) => PageBlockLike[];
  upsertPageBlocks?: (
    processingBuildId: string,
    pageNumber: number,
    blocks: PageBlockLike[],
  ) => void;
  replaceBlocksForBuild: (
    processingBuildId: string,
    blocks: PageBlockLike[],
  ) => void;
  clearBuild: (processingBuildId: string) => void;
};

type ProcessingBuildsStore = {
  beginBuild: (input: {
    revisionId: string;
    ocrEngine?: string | null;
    ocrVersion?: string | null;
    configHash: string;
  }) => { id: string };
  markRunning: (id: string) => void;
  markFailed: (id: string, error: string) => void;
  get?: (
    id: string,
  ) => { status?: string; isActive?: number | boolean } | null | undefined;
};

export type ProcessRevisionJobContext = {
  payload: {
    namespace?: string;
    documentId?: string;
    processingBuildId?: string;
    revisionId?: string;
    ocrMode?: string;
  };
  onProgress?: (progress: Record<string, unknown>) => void;
  heartbeat?: () => void;
  tryAcquireOcr: () => {
    ok: boolean;
    reason?: string;
    leaseId?: string;
  };
  releaseOcr: (leaseId?: string) => void;
  resolveOcrEngine: () => Promise<OcrEngine | null>;
  analyzePdfPages: (bytes: Buffer | ArrayBuffer | Uint8Array) => Promise<{
    pageCount: number;
    pages: Array<{
      pageNumber: number;
      text?: string;
      quality: { decision: string };
    }>;
  }>;
  summarizePageQualities: (
    pages: Array<{ decision: string }>,
  ) => { ocrPageCount: number; needsOcr: boolean };
  renderPdfPageToPng: (
    bytes: Buffer | Uint8Array | ArrayBuffer,
    pageNumber: number,
    options?: { tempDir?: string },
  ) => Promise<RenderedPageImage & { tempDir: string }>;
  cleanupRenderTemp: (tempDir: string) => Promise<void>;
  createChunker: () => {
    chunkDocument: (
      pages: Array<{ pageNumber: number; text: string }>,
    ) => Array<{ id?: string; content: string; pageNumber: number }>;
  };
  assignChunkIds: (
    chunks: Array<{ id?: string; content: string; pageNumber: number }>,
  ) => Array<{ id: string; content: string; pageNumber: number }>;
  commitChunks: (
    namespace: string,
    documentId: string,
    pageCount: number,
    chunks: Array<{ id: string; content: string; pageNumber: number }>,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  setDocumentStatus: (
    namespace: string,
    documentId: string,
    status: string,
    extra?: Record<string, unknown>,
  ) => Promise<void>;
  processingBuilds: ProcessingBuildsStore;
  documentBlocks: DocumentBlocksStore;
  getDocumentMeta: (
    namespace: string,
    documentId: string,
  ) => { storedPath?: string } | null;
  ocrMode?: string;
};

function isRelatedBlock(content: string, blockText: string): boolean {
  const snippet = String(blockText || "").trim();
  if (!snippet) return false;
  if (content.includes(snippet)) return true;
  // 前缀重叠：相关但未必能精确映射整段 → 后续会 bboxDegraded
  const prefixLen = Math.min(16, snippet.length);
  const prefix = snippet.slice(0, prefixLen);
  if (prefix.length >= 4 && content.includes(prefix)) return true;
  const head = content.slice(0, Math.min(48, content.length));
  return Boolean(head) && snippet.includes(head);
}

/**
 * 精确映射：相关 block 的完整 text 均须作为 chunk.content 子串。
 * 完全不匹配 / 部分匹配 → bboxDegraded，不写不完整 bbox refs。
 */
export function selectBlocksForChunk(
  chunk: { content: string; pageNumber: number },
  pageBlocks: Array<{
    id: string;
    pageNumber: number;
    text: string;
    readingOrder?: number;
  }>,
): ChunkBlockMapping {
  if (!pageBlocks.length) {
    return { refs: [], bboxDegraded: false };
  }
  const content = String(chunk.content || "");
  if (!content) {
    return { refs: [], bboxDegraded: false };
  }

  const ordered = [...pageBlocks].sort(
    (a, b) => (a.readingOrder ?? 0) - (b.readingOrder ?? 0),
  );
  const related = ordered.filter((b) => isRelatedBlock(content, b.text));
  if (related.length === 0) {
    return { refs: [], bboxDegraded: true };
  }

  const refs: ChunkBlockRef[] = [];
  let searchFrom = 0;
  for (const block of related) {
    const snippet = String(block.text || "");
    let idx = content.indexOf(snippet, searchFrom);
    if (idx < 0) idx = content.indexOf(snippet);
    if (idx < 0) {
      // 相关但无法精确映射整段 → 部分匹配降级
      return { refs: [], bboxDegraded: true };
    }
    refs.push({
      blockId: block.id,
      startOffset: idx,
      endOffset: idx + snippet.length,
    });
    searchFrom = idx + snippet.length;
  }

  return { refs, bboxDegraded: false };
}

function markPageDone(
  documentBlocks: DocumentBlocksStore,
  processingBuildId: string,
  pageNumber: number,
  decision: string,
) {
  if (typeof documentBlocks.markPageCheckpoint === "function") {
    documentBlocks.markPageCheckpoint(processingBuildId, pageNumber, {
      decision,
      status: "completed",
    });
  }
}

export async function runProcessRevisionJob(ctx: ProcessRevisionJobContext) {
  const {
    payload,
    onProgress,
    heartbeat,
    tryAcquireOcr,
    releaseOcr,
    resolveOcrEngine,
    analyzePdfPages,
    summarizePageQualities,
    renderPdfPageToPng,
    cleanupRenderTemp,
    createChunker,
    assignChunkIds,
    commitChunks,
    setDocumentStatus,
    processingBuilds,
    documentBlocks,
    getDocumentMeta,
    ocrMode = "auto",
  } = ctx;

  const namespace =
    payload.namespace === "conversation" ? "conversation" : "library";
  const documentId = String(payload.documentId || "");
  if (!documentId) throw new Error("process_revision 缺少 documentId");

  const meta = getDocumentMeta(namespace, documentId);
  if (!meta?.storedPath) throw new Error("文档原件不存在");

  let processingBuildId =
    typeof payload.processingBuildId === "string"
      ? payload.processingBuildId
      : null;
  const revisionId =
    typeof payload.revisionId === "string" ? payload.revisionId : null;

  const mode = payload.ocrMode === "disabled" ? "disabled" : ocrMode;

  await setDocumentStatus(namespace, documentId, "processing", {
    errorMessage: null,
  });
  onProgress?.({ phase: "analyzing", documentId });

  const bytes = readFileSync(meta.storedPath);
  const analyzed = await analyzePdfPages(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const qualities = analyzed.pages.map((p) => p.quality);
  const summary = summarizePageQualities(qualities);

  // 需要 OCR 且用户禁用：整体失败，保留原件与旧 active build
  if (summary.needsOcr && mode === "disabled") {
    const code = "OCR_DISABLED";
    if (processingBuildId) processingBuilds.markFailed(processingBuildId, code);
    await setDocumentStatus(namespace, documentId, "processing_error", {
      errorMessage: code,
    });
    throw new Error(code);
  }

  if (
    summary.ocrPageCount > OCR_CONFIG.maxOcrPagesPerDocument &&
    mode !== "disabled"
  ) {
    const code = "OCR_PAGE_LIMIT_EXCEEDED";
    if (processingBuildId) processingBuilds.markFailed(processingBuildId, code);
    await setDocumentStatus(namespace, documentId, "processing_error", {
      errorMessage: code,
    });
    throw new Error(code);
  }

  const ocrEngine = mode === "disabled" ? null : await resolveOcrEngine();
  if (summary.needsOcr && mode !== "disabled") {
    if (!ocrEngine) {
      const code = "OCR_UNAVAILABLE";
      if (processingBuildId) processingBuilds.markFailed(processingBuildId, code);
      await setDocumentStatus(namespace, documentId, "processing_error", {
        errorMessage: code,
      });
      throw new Error(code);
    }
  }

  if (!processingBuildId) {
    if (!revisionId) throw new Error("process_revision 缺少 revisionId");
    const cap = ocrEngine ? await ocrEngine.capabilities() : null;
    const build = processingBuilds.beginBuild({
      revisionId,
      ocrEngine: cap?.engine ?? null,
      ocrVersion: cap?.engineVersion ?? null,
      configHash: `ocr:${mode}:${OCR_CONFIG.recognitionLevel}:v${OCR_CONFIG.helperProtocolVersion}`,
    });
    processingBuildId = build.id;
  }

  processingBuilds.markRunning(processingBuildId);

  const checkpointPages = new Set(
    typeof documentBlocks.listCheckpointPages === "function"
      ? documentBlocks.listCheckpointPages(processingBuildId)
      : [],
  );

  onProgress?.({
    phase: "ocr",
    totalPages: analyzed.pageCount,
    ocrPagesTotal: summary.ocrPageCount,
    ocrPagesCompleted: 0,
    checkpointPages: checkpointPages.size,
  });

  /** @type {Array<{ pageNumber: number, text: string, blocks: PageBlockLike[] }>} */
  const pageResults: Array<{
    pageNumber: number;
    text: string;
    blocks: PageBlockLike[];
  }> = [];
  let ocrDone = 0;
  let tempDirToClean: string | null = null;
  let sessionStarted = false;

  try {
    if (ocrEngine && typeof ocrEngine.beginSession === "function") {
      await ocrEngine.beginSession();
      sessionStarted = true;
    }

    for (const page of analyzed.pages) {
      heartbeat?.();
      const decision = page.quality.decision;

      // 续跑：已 checkpoint 的页从 DB 恢复
      if (checkpointPages.has(page.pageNumber)) {
        const existing = documentBlocks
          .listBlocks(processingBuildId)
          .filter((b) => b.pageNumber === page.pageNumber);
        const text = existing.map((b) => b.text).filter(Boolean).join("\n");
        pageResults.push({
          pageNumber: page.pageNumber,
          text,
          blocks: existing.map((b) => ({
            id: b.id,
            pageNumber: b.pageNumber,
            readingOrder: b.readingOrder,
            text: b.text,
            origin: b.origin,
            bbox: b.bbox,
            confidence: b.confidence,
            language: b.language,
          })),
        });
        if (decision === "ocr") ocrDone += 1;
        continue;
      }

      if (decision === "native") {
        const text = page.text || "";
        const blocks = text
          ? [
              {
                id: randomUUID(),
                pageNumber: page.pageNumber,
                readingOrder: 0,
                text,
                origin: "native_text",
                bbox: null,
              },
            ]
          : [];
        if (typeof documentBlocks.upsertPageBlocks === "function") {
          documentBlocks.upsertPageBlocks(
            processingBuildId,
            page.pageNumber,
            blocks,
          );
        }
        markPageDone(documentBlocks, processingBuildId, page.pageNumber, "native");
        pageResults.push({ pageNumber: page.pageNumber, text, blocks });
        continue;
      }

      if (decision === "blank") {
        if (typeof documentBlocks.upsertPageBlocks === "function") {
          documentBlocks.upsertPageBlocks(
            processingBuildId,
            page.pageNumber,
            [],
          );
        }
        markPageDone(documentBlocks, processingBuildId, page.pageNumber, "blank");
        pageResults.push({ pageNumber: page.pageNumber, text: "", blocks: [] });
        continue;
      }

      // OCR page（disabled + needsOcr 已在上方整体失败，此处不会把 ocr 改 blank）
      const acquire = tryAcquireOcr();
      if (!acquire.ok) {
        const err = new Error(
          `OCR_LEASE_BUSY:${acquire.reason || "busy"}`,
        ) as Error & { code?: string };
        err.code = "OCR_LEASE_BUSY";
        throw err;
      }
      try {
        onProgress?.({
          phase: "ocr",
          page: page.pageNumber,
          totalPages: analyzed.pageCount,
          ocrPagesTotal: summary.ocrPageCount,
          ocrPagesCompleted: ocrDone,
        });
        if (!ocrEngine) {
          throw new Error("OCR_UNAVAILABLE");
        }
        const rendered = await renderPdfPageToPng(bytes, page.pageNumber, {
          tempDir: tempDirToClean || undefined,
        });
        tempDirToClean = rendered.tempDir;
        const recognized = await ocrEngine.recognizePage({
          pageNumber: page.pageNumber,
          imageBytes: rendered.bytes,
          mimeType: "image/png",
          width: rendered.width,
          height: rendered.height,
          recognitionLevel: OCR_CONFIG.recognitionLevel,
          imagePath: rendered.pngPath,
        });
        const blocks = recognized.blocks.map((b, i) => ({
          id: randomUUID(),
          pageNumber: page.pageNumber,
          readingOrder: b.readingOrder ?? i,
          text: b.text,
          origin: "ocr",
          bbox: b.bbox,
          confidence: b.confidence ?? null,
          language: b.language ?? null,
        }));
        if (typeof documentBlocks.upsertPageBlocks === "function") {
          documentBlocks.upsertPageBlocks(
            processingBuildId,
            page.pageNumber,
            blocks,
          );
        }
        markPageDone(documentBlocks, processingBuildId, page.pageNumber, "ocr");
        pageResults.push({
          pageNumber: page.pageNumber,
          text: recognized.text,
          blocks,
        });
        ocrDone += 1;
        onProgress?.({
          phase: "ocr",
          page: page.pageNumber,
          totalPages: analyzed.pageCount,
          ocrPagesTotal: summary.ocrPageCount,
          ocrPagesCompleted: ocrDone,
        });
      } finally {
        releaseOcr(acquire.leaseId);
      }
    }

    onProgress?.({ phase: "normalizing" });
    // 统一 readingOrder 全局序；以 checkpoint 汇总为准
    const allBlocks: PageBlockLike[] = [];
    let orderGlobal = 0;
    for (const page of pageResults) {
      for (const block of page.blocks) {
        allBlocks.push({
          ...block,
          id: block.id || randomUUID(),
          readingOrder: orderGlobal++,
        });
      }
    }
    // 最终一致快照（含 readingOrder 重整）
    documentBlocks.replaceBlocksForBuild(processingBuildId, allBlocks);

    onProgress?.({ phase: "chunking" });
    const parsedPages = pageResults.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
    }));
    const chunker = createChunker();
    const rawChunks = chunker.chunkDocument(parsedPages);
    if (rawChunks.length === 0) {
      const code = "OCR_NO_TEXT";
      processingBuilds.markFailed(processingBuildId, code);
      documentBlocks.clearBuild(processingBuildId);
      await setDocumentStatus(namespace, documentId, "processing_error", {
        errorMessage: code,
      });
      throw new Error(code);
    }
    const chunks = assignChunkIds(rawChunks);

    const blocksByPage = new Map();
    for (const b of allBlocks) {
      const list = blocksByPage.get(b.pageNumber) || [];
      list.push(b);
      blocksByPage.set(b.pageNumber, list);
    }

    /** @type {Array<{ chunkId: string, refs: ChunkBlockRef[] }>} */
    const chunkBlockRefs = [];
    /** @type {Array<{ chunkId: string, pageNumber: number, bboxDegraded: boolean }>} */
    const chunkLocators = [];
    for (const chunk of chunks) {
      const pageBlocks = blocksByPage.get(chunk.pageNumber) || [];
      const mapping = selectBlocksForChunk(chunk, pageBlocks);
      chunkLocators.push({
        chunkId: chunk.id,
        pageNumber: chunk.pageNumber,
        bboxDegraded: mapping.bboxDegraded,
      });
      // 仅完整精确映射时写入 block refs；降级只保留 page locator
      if (!mapping.bboxDegraded && mapping.refs.length > 0) {
        chunkBlockRefs.push({
          chunkId: chunk.id,
          refs: mapping.refs.map((r) => ({ ...r, bboxDegraded: false })),
        });
      }
    }

    onProgress?.({ phase: "keyword_index" });
    // 同一事务：chunks + FTS + locators + refs + ProcessingBuild + keyword IndexBuild
    const committed = await commitChunks(
      namespace,
      documentId,
      analyzed.pageCount,
      chunks,
      {
        processingBuildId,
        activateProcessing: true,
        chunkBlockRefs,
        chunkLocators,
      },
    );

    await setDocumentStatus(namespace, documentId, "ready", {
      errorMessage: null,
    });

    return {
      processingBuildId,
      pageCount: analyzed.pageCount,
      ocrPages: ocrDone,
      chunkCount: chunks.length,
      document: committed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const leaseBusy = String(message).startsWith("OCR_LEASE_BUSY");
    let alreadyActive = false;
    if (processingBuildId && !leaseBusy) {
      try {
        const row = processingBuilds.get?.(processingBuildId);
        alreadyActive = Boolean(
          row && row.status === "ready" && row.isActive,
        );
        // 已激活成功则不得 markFailed / 回退 active
        if (!alreadyActive) {
          processingBuilds.markFailed(processingBuildId, message);
        }
      } catch {
        // ignore
      }
    }
    if (!leaseBusy && !alreadyActive) {
      await setDocumentStatus(namespace, documentId, "processing_error", {
        errorMessage: message.slice(0, 500),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (sessionStarted && ocrEngine && typeof ocrEngine.endSession === "function") {
      await ocrEngine.endSession().catch(() => undefined);
    }
    if (tempDirToClean) {
      await cleanupRenderTemp(tempDirToClean);
    }
  }
}
