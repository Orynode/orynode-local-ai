/**
 * PageTextQuality 单元测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPageTextQuality,
  summarizePageQualities,
} from "../../services/knowledge/processing/page-quality";

test("assessPageTextQuality: 可用原生文本 → native", () => {
  const text = "这是一段足够长的中文测试文本，用于验证页面质量判定不会误进 OCR。";
  const q = assessPageTextQuality({ pageNumber: 1, text });
  assert.equal(q.decision, "native");
  assert.ok(q.meaningfulCharacters >= 24);
});

test("assessPageTextQuality: 真空白 → blank", () => {
  const q = assessPageTextQuality({ pageNumber: 2, text: "" });
  assert.equal(q.decision, "blank");
  assert.equal(q.reason, "empty_text_no_raster");
});

test("assessPageTextQuality: 无字但有大图 → ocr", () => {
  const q = assessPageTextQuality({
    pageNumber: 3,
    text: "",
    hasLargeRasterImage: true,
  });
  assert.equal(q.decision, "ocr");
  assert.equal(q.reason, "raster_without_text");
});

test("assessPageTextQuality: 替换符比例过高 → ocr", () => {
  const text = `${"\uFFFD".repeat(40)}abc`;
  const q = assessPageTextQuality({ pageNumber: 4, text });
  assert.equal(q.decision, "ocr");
});

test("assessPageTextQuality: 稀疏文本无图 → blank", () => {
  const q = assessPageTextQuality({ pageNumber: 5, text: "hi" });
  assert.equal(q.decision, "blank");
});

test("summarizePageQualities: needsOcr", () => {
  const pages = [
    assessPageTextQuality({ pageNumber: 1, text: "足够长的原生正文用于测试页面质量判定逻辑一二三四五六七八九十" }),
    assessPageTextQuality({
      pageNumber: 2,
      text: "",
      hasLargeRasterImage: true,
    }),
  ];
  const s = summarizePageQualities(pages);
  assert.equal(s.needsOcr, true);
  assert.equal(s.ocrPageCount, 1);
  assert.equal(s.nativePageCount, 1);
});
