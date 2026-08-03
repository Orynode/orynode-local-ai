/**
 * process_revision 编排集成测试（Fake OCR，无真实 Vision / 大 PDF）
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakeOcrEngine } from "../../services/platform/ocr/fake-ocr";
import {
  runProcessRevisionJob,
  selectBlocksForChunk,
} from "../../services/knowledge/processing/run-process-revision";

function createMemoryBlockStore() {
  /** @type {Map<string, any[]>} */
  const byBuild = new Map();
  /** @type {Map<string, Set<number>>} */
  const checkpoints = new Map();
  return {
    replaceBlocksForBuild(processingBuildId, blocks) {
      byBuild.set(processingBuildId, blocks.map((b) => ({ ...b })));
      return blocks.map((b) => b.id);
    },
    upsertPageBlocks(processingBuildId, pageNumber, blocks) {
      const all = byBuild.get(processingBuildId) || [];
      const next = all.filter((b) => b.pageNumber !== pageNumber);
      next.push(...blocks.map((b) => ({ ...b, pageNumber })));
      byBuild.set(processingBuildId, next);
      return blocks.map((b) => b.id);
    },
    markPageCheckpoint(processingBuildId, pageNumber, input) {
      if (input.status === "failed") return;
      const set = checkpoints.get(processingBuildId) || new Set();
      set.add(pageNumber);
      checkpoints.set(processingBuildId, set);
    },
    listCheckpointPages(processingBuildId) {
      const fromPages = checkpoints.get(processingBuildId);
      if (fromPages?.size) {
        return [...fromPages].sort((a, b) => a - b);
      }
      const pages = new Set(
        (byBuild.get(processingBuildId) || []).map((b) => b.pageNumber),
      );
      return [...pages].sort((a, b) => a - b);
    },
    listBlocks(processingBuildId) {
      return [...(byBuild.get(processingBuildId) || [])];
    },
    clearBuild(processingBuildId) {
      byBuild.delete(processingBuildId);
      checkpoints.delete(processingBuildId);
    },
    setChunkBlockRefs() {},
    listChunkBlockRefs() {
      return [];
    },
    _dump(processingBuildId) {
      return byBuild.get(processingBuildId) || [];
    },
  };
}

function createMemoryProcessingBuilds() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  return {
    beginBuild({ revisionId, configHash }) {
      const id = `pb-${rows.size + 1}`;
      const row = {
        id,
        revisionId,
        status: "queued",
        isActive: 0,
        configHash,
      };
      rows.set(id, row);
      return row;
    },
    markRunning(id) {
      const row = rows.get(id);
      row.status = "running";
      return row;
    },
    activateReady(id) {
      for (const r of rows.values()) {
        if (r.revisionId === rows.get(id).revisionId && r.isActive) {
          r.isActive = 0;
          r.status = "superseded";
        }
      }
      const row = rows.get(id);
      row.status = "ready";
      row.isActive = 1;
      return row;
    },
    markFailed(id, error) {
      const row = rows.get(id);
      row.status = "failed";
      row.isActive = 0;
      row.error = error;
      return row;
    },
    get(id) {
      return rows.get(id) ?? null;
    },
  };
}

test("process_revision: Fake OCR 完成且成功后才 activate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-pr-"));
  const pdfPath = join(dir, "doc.pdf");
  writeFileSync(pdfPath, Buffer.from("%PDF-1.4 fake"));

  const blocks = createMemoryBlockStore();
  const builds = createMemoryProcessingBuilds();
  const build = builds.beginBuild({ revisionId: "rev-1", configHash: "t" });
  let activatedBeforeCommit = false;
  let commitCalled = false;

  const engine = createFakeOcrEngine();
  await engine.beginSession?.();

  try {
    const result = await runProcessRevisionJob({
      payload: {
        namespace: "library",
        documentId: "doc-1",
        revisionId: "rev-1",
        processingBuildId: build.id,
        ocrMode: "auto",
      },
      ocrMode: "auto",
      resolveOcrEngine: async () => engine,
      tryAcquireOcr: () => ({ ok: true, leaseId: "lease-1" }),
      releaseOcr: () => undefined,
      analyzePdfPages: async () => ({
        pageCount: 2,
        pages: [
          {
            pageNumber: 1,
            text: "",
            quality: {
              pageNumber: 1,
              decision: "ocr",
              reason: "raster_without_text",
              extractedCharacters: 0,
              meaningfulCharacters: 0,
              replacementCharacterRatio: 0,
              hasLargeRasterImage: true,
            },
          },
          {
            pageNumber: 2,
            text: "足够长的原生正文用于判定 native 路径一二三四五六七八九十",
            quality: {
              pageNumber: 2,
              decision: "native",
              reason: "usable_native_text",
              extractedCharacters: 40,
              meaningfulCharacters: 40,
              replacementCharacterRatio: 0,
              hasLargeRasterImage: false,
            },
          },
        ],
        parsed: { pageCount: 2, pages: [] },
      }),
      summarizePageQualities: (pages) => ({
        needsOcr: pages.some((p) => p.decision === "ocr"),
        ocrPageCount: pages.filter((p) => p.decision === "ocr").length,
        nativePageCount: pages.filter((p) => p.decision === "native").length,
        blankPageCount: 0,
      }),
      renderPdfPageToPng: async () => ({
        pageNumber: 1,
        pngPath: join(dir, "p1.png"),
        width: 100,
        height: 100,
        bytes: new Uint8Array([1, 2, 3]),
        tempDir: dir,
      }),
      cleanupRenderTemp: async () => undefined,
      createChunker: () => ({
        chunkDocument: (pages) =>
          pages
            .filter((p) => p.text?.trim())
            .map((p, i) => ({
              pageNumber: p.pageNumber,
              position: i,
              content: p.text,
            })),
      }),
      assignChunkIds: (chunks) =>
        chunks.map((c, i) => ({ ...c, id: `c${i}` })),
      commitChunks: async (_ns, _id, _pc, chunks, options) => {
        commitCalled = true;
        assert.equal(options.activateProcessing, true);
        assert.ok(Array.isArray(options.chunkBlockRefs));
        assert.equal(builds.get(build.id).isActive, 0);
        assert.equal(builds.get(build.id).status, "running");
        activatedBeforeCommit = builds.get(build.id).isActive === 1;
        // 模拟原子激活：commit 内切换 active
        builds.activateReady(build.id);
        return { id: "doc-1", chunkCount: chunks.length, status: "ready" };
      },
      setDocumentStatus: async () => undefined,
      processingBuilds: builds,
      documentBlocks: blocks,
      getDocumentMeta: () => ({ storedPath: pdfPath, contentHash: "h1" }),
    });

    assert.equal(activatedBeforeCommit, false);
    assert.equal(commitCalled, true);
    assert.equal(builds.get(build.id).status, "ready");
    assert.equal(builds.get(build.id).isActive, 1);
    assert.ok(result.chunkCount >= 1);
    assert.ok(blocks.listBlocks(build.id).length >= 1);
  } finally {
    await engine.endSession?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process_revision: 失败保留 checkpoint，续跑跳过已完成页", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-pr2-"));
  const pdfPath = join(dir, "doc.pdf");
  writeFileSync(pdfPath, Buffer.from("%PDF-1.4 fake"));

  const blocks = createMemoryBlockStore();
  const builds = createMemoryProcessingBuilds();
  const build = builds.beginBuild({ revisionId: "rev-2", configHash: "t" });

  let ocrCalls = 0;
  const engine = createFakeOcrEngine({
    failWith: undefined,
  });
  // 第一轮：第 1 页成功后人为失败
  const originalRecognize = engine.recognizePage.bind(engine);
  engine.recognizePage = async (input, signal) => {
    ocrCalls += 1;
    if (ocrCalls === 1) {
      return originalRecognize(input, signal);
    }
    throw new Error("OCR_TIMEOUT");
  };

  const analyzed = {
    pageCount: 2,
    pages: [
      {
        pageNumber: 1,
        text: "",
        quality: {
          pageNumber: 1,
          decision: "ocr",
          reason: "raster_without_text",
          extractedCharacters: 0,
          meaningfulCharacters: 0,
          replacementCharacterRatio: 0,
          hasLargeRasterImage: true,
        },
      },
      {
        pageNumber: 2,
        text: "",
        quality: {
          pageNumber: 2,
          decision: "ocr",
          reason: "raster_without_text",
          extractedCharacters: 0,
          meaningfulCharacters: 0,
          replacementCharacterRatio: 0,
          hasLargeRasterImage: true,
        },
      },
    ],
    parsed: { pageCount: 2, pages: [] },
  };

  const baseCtx = {
    payload: {
      namespace: "library",
      documentId: "doc-2",
      revisionId: "rev-2",
      processingBuildId: build.id,
      ocrMode: "auto",
    },
    ocrMode: "auto",
    resolveOcrEngine: async () => engine,
    tryAcquireOcr: () => ({ ok: true, leaseId: "l1" }),
    releaseOcr: () => undefined,
    analyzePdfPages: async () => analyzed,
    summarizePageQualities: () => ({
      needsOcr: true,
      ocrPageCount: 2,
      nativePageCount: 0,
      blankPageCount: 0,
    }),
    renderPdfPageToPng: async (_b, pageNumber) => ({
      pageNumber,
      pngPath: join(dir, `p${pageNumber}.png`),
      width: 10,
      height: 10,
      bytes: new Uint8Array([1]),
      tempDir: dir,
    }),
    cleanupRenderTemp: async () => undefined,
    createChunker: () => ({
      chunkDocument: (pages) =>
        pages
          .filter((p) => p.text?.trim())
          .map((p, i) => ({
            pageNumber: p.pageNumber,
            position: i,
            content: p.text,
          })),
    }),
    assignChunkIds: (chunks) => chunks.map((c, i) => ({ ...c, id: `c${i}` })),
    commitChunks: async (_ns, _id, _pc, _chunks, options) => {
      assert.equal(options.activateProcessing, true);
      builds.activateReady(build.id);
      return { id: "doc-2" };
    },
    setDocumentStatus: async () => undefined,
    processingBuilds: builds,
    documentBlocks: blocks,
    getDocumentMeta: () => ({ storedPath: pdfPath, contentHash: "h2" }),
  };

  await assert.rejects(() => runProcessRevisionJob(baseCtx), /OCR_TIMEOUT/);
  assert.deepEqual(blocks.listCheckpointPages(build.id), [1]);
  assert.equal(builds.get(build.id).status, "failed");
  assert.equal(builds.get(build.id).isActive, 0);

  // 续跑：恢复 recognize，应跳过页 1
  ocrCalls = 0;
  engine.recognizePage = async (input, signal) => {
    ocrCalls += 1;
    assert.equal(input.pageNumber, 2);
    return originalRecognize(input, signal);
  };
  builds.markRunning(build.id);

  const result = await runProcessRevisionJob(baseCtx);
  assert.equal(ocrCalls, 1);
  assert.equal(result.pageCount, 2);
  assert.equal(builds.get(build.id).status, "ready");

  rmSync(dir, { recursive: true, force: true });
});

test("selectBlocksForChunk 精确 offset；完全不匹配 / 部分匹配均 bboxDegraded", () => {
  const selected = selectBlocksForChunk(
    { content: "hello world", pageNumber: 1 },
    [{ id: "1", pageNumber: 1, text: "hello world", readingOrder: 0 }],
  );
  assert.equal(selected.refs.length, 1);
  assert.equal(selected.refs[0].startOffset, 0);
  assert.equal(selected.bboxDegraded, false);

  const none = selectBlocksForChunk(
    { content: "完全不同的文本", pageNumber: 1 },
    [{ id: "1", pageNumber: 1, text: "hello", readingOrder: 0 }],
  );
  assert.equal(none.refs.length, 0);
  assert.equal(none.bboxDegraded, true);

  // 相关（前缀命中）但整段无法精确映射 → 部分匹配降级
  const partial = selectBlocksForChunk(
    { content: "标题甲开头的内容", pageNumber: 1 },
    [
      {
        id: "a",
        pageNumber: 1,
        text: "标题甲开头的内容以及更多未进入 chunk 的尾巴",
        readingOrder: 0,
      },
    ],
  );
  assert.equal(partial.refs.length, 0);
  assert.equal(partial.bboxDegraded, true);
});

test("process_revision: ocrMode=disabled 且 needsOcr 时整体 OCR_DISABLED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-pr-dis-"));
  const pdfPath = join(dir, "doc.pdf");
  writeFileSync(pdfPath, Buffer.from("%PDF-1.4 fake"));
  const blocks = createMemoryBlockStore();
  const builds = createMemoryProcessingBuilds();
  const build = builds.beginBuild({ revisionId: "rev-d", configHash: "t" });
  let commitCalled = false;

  await assert.rejects(
    () =>
      runProcessRevisionJob({
        payload: {
          namespace: "library",
          documentId: "doc-d",
          revisionId: "rev-d",
          processingBuildId: build.id,
          ocrMode: "disabled",
        },
        ocrMode: "disabled",
        resolveOcrEngine: async () => null,
        tryAcquireOcr: () => ({ ok: true, leaseId: "x" }),
        releaseOcr: () => undefined,
        analyzePdfPages: async () => ({
          pageCount: 1,
          pages: [
            {
              pageNumber: 1,
              text: "",
              quality: {
                pageNumber: 1,
                decision: "ocr",
                reason: "raster_without_text",
                extractedCharacters: 0,
                meaningfulCharacters: 0,
                replacementCharacterRatio: 0,
                hasLargeRasterImage: true,
              },
            },
          ],
          parsed: { pageCount: 1, pages: [] },
        }),
        summarizePageQualities: () => ({
          needsOcr: true,
          ocrPageCount: 1,
          nativePageCount: 0,
          blankPageCount: 0,
        }),
        renderPdfPageToPng: async () => {
          throw new Error("不应渲染");
        },
        cleanupRenderTemp: async () => undefined,
        createChunker: () => ({ chunkDocument: () => [] }),
        assignChunkIds: (c) => c,
        commitChunks: async () => {
          commitCalled = true;
          return {};
        },
        setDocumentStatus: async () => undefined,
        processingBuilds: builds,
        documentBlocks: blocks,
        getDocumentMeta: () => ({ storedPath: pdfPath, contentHash: "hd" }),
      }),
    /OCR_DISABLED/,
  );
  assert.equal(commitCalled, false);
  assert.equal(builds.get(build.id).status, "failed");
  assert.equal(builds.get(build.id).isActive, 0);
  rmSync(dir, { recursive: true, force: true });
});
