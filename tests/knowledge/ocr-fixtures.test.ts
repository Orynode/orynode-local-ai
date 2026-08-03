/**
 * OCR fixtures + bbox / fake helper 回归
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assessPageTextQuality,
  summarizePageQualities,
} from "../../services/knowledge/processing/page-quality";
import { locatorBboxFromBlockRefs } from "../../services/knowledge/context/bbox-from-blocks";
import { createFakeOcrEngine } from "../../services/platform/ocr/fake-ocr";
import {
  parseHelperResponseLine,
  OCR_HELPER_PROTOCOL_VERSION,
} from "../../services/platform/macos/ocr-helper-protocol";

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/ocr",
);

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(join(fixtureDir, `${name}.json`), "utf8"),
  ) as {
    pages: Array<{
      pageNumber: number;
      text: string;
      hasLargeRasterImage?: boolean;
    }>;
  };
}

test("ocr fixtures: native 不需要 OCR", () => {
  const fixture = loadFixture("native");
  const qualities = fixture.pages.map((p) =>
    assessPageTextQuality({
      pageNumber: p.pageNumber,
      text: p.text,
      hasLargeRasterImage: p.hasLargeRasterImage,
    }),
  );
  const summary = summarizePageQualities(qualities);
  assert.equal(summary.needsOcr, false);
  assert.equal(qualities[0]?.decision, "native");
});

test("ocr fixtures: scan-like 需要 OCR", () => {
  const fixture = loadFixture("scan-like");
  const qualities = fixture.pages.map((p) =>
    assessPageTextQuality({
      pageNumber: p.pageNumber,
      text: p.text,
      hasLargeRasterImage: p.hasLargeRasterImage,
    }),
  );
  assert.equal(summarizePageQualities(qualities).needsOcr, true);
});

test("ocr fixtures: mixed 仅扫描页进 OCR", () => {
  const fixture = loadFixture("mixed");
  const qualities = fixture.pages.map((p) =>
    assessPageTextQuality({
      pageNumber: p.pageNumber,
      text: p.text,
      hasLargeRasterImage: p.hasLargeRasterImage,
    }),
  );
  const summary = summarizePageQualities(qualities);
  assert.equal(summary.needsOcr, true);
  assert.equal(summary.ocrPageCount, 1);
  assert.equal(qualities[0]?.decision, "native");
  assert.equal(qualities[1]?.decision, "ocr");
  assert.equal(qualities[2]?.decision, "blank");
});

test("locatorBboxFromBlockRefs: 单块写入 bbox", () => {
  const result = locatorBboxFromBlockRefs(
    [{ pageNumber: 1, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } }],
    1,
  );
  assert.deepEqual(result.bbox, [0.1, 0.2, 0.3, 0.05]);
  assert.equal(result.degraded, false);
});

test("locatorBboxFromBlockRefs: 分散区域 degraded", () => {
  const result = locatorBboxFromBlockRefs(
    [
      { pageNumber: 1, bbox: { x: 0.05, y: 0.05, width: 0.2, height: 0.1 } },
      { pageNumber: 1, bbox: { x: 0.7, y: 0.75, width: 0.2, height: 0.1 } },
    ],
    1,
  );
  assert.equal(result.degraded, true);
  assert.equal(result.bbox, undefined);
});

test("fake OCR helper protocol line 可解析", () => {
  const line = JSON.stringify({
    protocolVersion: OCR_HELPER_PROTOCOL_VERSION,
    requestId: "req-1",
    ok: true,
    pageNumber: 1,
    text: "hello",
    blocks: [
      {
        text: "hello",
        bbox: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
        readingOrder: 0,
        confidence: 0.9,
      },
    ],
    engine: "fake",
    engineVersion: "test",
    warnings: [],
  });
  const parsed = parseHelperResponseLine(line, {
    requestId: "req-1",
    pageNumber: 1,
  });
  assert.equal(parsed.pageNumber, 1);
  assert.ok(parsed.text.includes("hello") || parsed.blocks.length >= 1);
});

test("selectBlocksForChunk: 优先匹配覆盖文本的 blocks", async () => {
  const { selectBlocksForChunk } = await import(
    "../../services/knowledge/processing/run-process-revision"
  );
  const pageBlocks = [
    { id: "a", pageNumber: 1, text: "标题甲" },
    { id: "b", pageNumber: 1, text: "正文段落内容很长用于匹配" },
    { id: "c", pageNumber: 1, text: "页脚无关" },
  ];
  // 仅一块相关且可精确映射
  const selected = selectBlocksForChunk(
    { content: "正文段落内容很长用于匹配", pageNumber: 1 },
    pageBlocks,
  );
  assert.equal(selected.bboxDegraded, false);
  assert.deepEqual(
    selected.refs.map((b) => b.blockId),
    ["b"],
  );
  assert.equal(typeof selected.refs[0].startOffset, "number");

  // 前缀相关但整段无法映射 → 部分匹配降级
  const partial = selectBlocksForChunk(
    { content: "title head shared prefix only", pageNumber: 1 },
    [
      { id: "a", pageNumber: 1, text: "title head" },
      {
        id: "b",
        pageNumber: 1,
        text: "shared prefix only AND_EXTRA_TAIL_OUTSIDE_CHUNK",
      },
    ],
  );
  assert.equal(partial.bboxDegraded, true);
  assert.equal(partial.refs.length, 0);
});

test("fake OcrEngine.recognizePage 契约", async () => {
  const engine = createFakeOcrEngine({
    pages: new Map([
      [
        1,
        {
          pageNumber: 1,
          text: "扫描文字",
          blocks: [
            {
              text: "扫描文字",
              bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.08 },
              readingOrder: 0,
            },
          ],
          engine: "fake-ocr",
          engineVersion: "test-1",
          warnings: [],
        },
      ],
    ]),
  });
  const cap = await engine.capabilities();
  assert.equal(cap.available, true);
  assert.equal(cap.boundingBoxes, true);
  const result = await engine.recognizePage({
    pageNumber: 1,
    imageBytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    width: 100,
    height: 100,
    recognitionLevel: "fast",
  });
  assert.equal(result.text, "扫描文字");
  assert.equal(result.blocks.length, 1);
});
