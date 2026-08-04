/**
 * OCR 契约测试：Fake adapter + bbox + helper 协议
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNormalizedBbox,
  unionBboxes,
  visionBboxToTopLeft,
} from "../../services/platform/ocr/bbox";
import { createFakeOcrEngine } from "../../services/platform/ocr/fake-ocr";
import {
  OCR_HELPER_PROTOCOL_VERSION,
  parseHelperResponseLine,
} from "../../services/platform/macos/ocr-helper-protocol";
import { OCR_CONFIG } from "../../config/defaults";

test("OCR_CONFIG: 首版安全上限集中配置", () => {
  assert.equal(OCR_CONFIG.minMeaningfulCharacters, 24);
  assert.equal(OCR_CONFIG.ocrPageConcurrency, 1);
  assert.equal(OCR_CONFIG.maxOcrPagesPerDocument, 100);
});

test("parseNormalizedBbox: 接受合法框，钳位越界，拒绝 NaN/负尺寸", () => {
  assert.deepEqual(parseNormalizedBbox({ x: 0, y: 0.2, width: 0.5, height: 0.1 }), {
    x: 0,
    y: 0.2,
    width: 0.5,
    height: 0.1,
  });
  assert.throws(() => parseNormalizedBbox({ x: NaN, y: 0, width: 0.1, height: 0.1 }));
  assert.throws(() =>
    parseNormalizedBbox({ x: 0, y: 0, width: -0.1, height: 0.1 }),
  );
  // Vision 浮点：x+width 略大于 1 → 裁剪宽度，不抛错
  assert.deepEqual(
    parseNormalizedBbox({
      x: 0.9518621577663624,
      y: 0.8958345151568872,
      width: 0.04821076561583948,
      height: 0.010830969686225655,
    }),
    {
      x: 0.9518621577663624,
      y: 0.8958345151568872,
      width: 1 - 0.9518621577663624,
      height: 0.010830969686225655,
    },
  );
  const clipped = parseNormalizedBbox({ x: 0.9, y: 0, width: 0.2, height: 0.1 });
  assert.equal(clipped.x, 0.9);
  assert.equal(clipped.y, 0);
  assert.equal(clipped.height, 0.1);
  assert.ok(Math.abs(clipped.width - 0.1) < 1e-12);
  assert.ok(clipped.x + clipped.width <= 1 + 1e-12);
});

test("visionBboxToTopLeft: 底左 → 顶左", () => {
  const top = visionBboxToTopLeft({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
  assert.ok(Math.abs(top.y - (1 - 0.2 - 0.1)) < 1e-9);
  assert.equal(top.x, 0.1);
});

test("unionBboxes: 合并；过大跨度返回 null", () => {
  const u = unionBboxes([
    { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    { x: 0.15, y: 0.2, width: 0.2, height: 0.05 },
  ]);
  assert.ok(u);
  assert.ok(u!.height > 0.1);
  assert.equal(
    unionBboxes([
      { x: 0, y: 0, width: 0.1, height: 0.1 },
      { x: 0.9, y: 0.9, width: 0.1, height: 0.1 },
    ]),
    null,
  );
});

test("FakeOcrEngine: capabilities + recognizePage 契约", async () => {
  const ocr = createFakeOcrEngine();
  const cap = await ocr.capabilities();
  assert.equal(cap.available, true);
  assert.equal(cap.boundingBoxes, true);

  const page = await ocr.recognizePage({
    pageNumber: 1,
    imageBytes: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    width: 100,
    height: 100,
    recognitionLevel: "fast",
  });
  assert.equal(page.pageNumber, 1);
  assert.ok(page.blocks.length >= 1);
  assert.equal(page.text, page.blocks.map((b) => b.text).join("\n"));
  for (const b of page.blocks) {
    parseNormalizedBbox(b.bbox);
  }
});

test("FakeOcrEngine: unavailable / abort", async () => {
  const dead = createFakeOcrEngine({ available: false, reason: "OCR_UNAVAILABLE" });
  assert.equal((await dead.capabilities()).available, false);
  await assert.rejects(
    () =>
      dead.recognizePage({
        pageNumber: 1,
        imageBytes: new Uint8Array(),
        mimeType: "image/png",
        width: 1,
        height: 1,
        recognitionLevel: "fast",
      }),
    /OCR_UNAVAILABLE/,
  );

  const slow = createFakeOcrEngine({ delayMs: 5_000 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      slow.recognizePage(
        {
          pageNumber: 2,
          imageBytes: new Uint8Array(),
          mimeType: "image/png",
          width: 1,
          height: 1,
          recognitionLevel: "fast",
        },
        ac.signal,
      ),
    /OCR_CANCELLED/,
  );
});

test("parseHelperResponseLine: 协议校验与排序", () => {
  const line = JSON.stringify({
    protocolVersion: OCR_HELPER_PROTOCOL_VERSION,
    requestId: "r1",
    pageNumber: 3,
    ok: true,
    engine: "fake",
    engineVersion: "1",
    blocks: [
      {
        text: "B",
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        readingOrder: 1,
      },
      {
        text: "A",
        bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
        readingOrder: 0,
      },
    ],
  });
  const page = parseHelperResponseLine(line, { requestId: "r1", pageNumber: 3 });
  assert.equal(page.text, "A\nB");
  assert.equal(page.blocks[0]?.readingOrder, 0);
});

test("parseHelperResponseLine: Vision 浮点越界 bbox 钳位保留文本", () => {
  const line = JSON.stringify({
    protocolVersion: OCR_HELPER_PROTOCOL_VERSION,
    requestId: "r2",
    pageNumber: 8,
    ok: true,
    engine: "apple-vision",
    engineVersion: "vision-framework",
    blocks: [
      {
        text: "edge",
        bbox: {
          x: 0.9518621577663624,
          y: 0.8958345151568872,
          width: 0.04821076561583948,
          height: 0.010830969686225655,
        },
        readingOrder: 0,
      },
      {
        text: "bad",
        bbox: { x: NaN, y: 0, width: 0.1, height: 0.1 },
        readingOrder: 1,
      },
    ],
  });
  const page = parseHelperResponseLine(line, { requestId: "r2", pageNumber: 8 });
  assert.equal(page.blocks.length, 1);
  assert.equal(page.text, "edge");
  assert.ok(page.blocks[0]!.bbox.x + page.blocks[0]!.bbox.width <= 1 + 1e-12);
  assert.ok(page.warnings?.includes("skipped_invalid_bbox"));
});

test("parseHelperResponseLine: 畸形 JSON / 错 requestId", () => {
  assert.throws(() => parseHelperResponseLine("{", { requestId: "r", pageNumber: 1 }));
  assert.throws(() =>
    parseHelperResponseLine(
      JSON.stringify({
        protocolVersion: OCR_HELPER_PROTOCOL_VERSION,
        requestId: "other",
        pageNumber: 1,
        ok: true,
        blocks: [],
        engine: "x",
        engineVersion: "1",
      }),
      { requestId: "r", pageNumber: 1 },
    ),
  );
});
