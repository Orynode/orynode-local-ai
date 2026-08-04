import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  highlightRectForNormalizedBbox,
  highlightRectsForOffsets,
  isHighlightPageActive,
  parsePreviewBbox,
  resolvePdfHighlightPlan,
} from "../../app/lib/preview-pdf-highlight";
import { lineStartOffset } from "../../app/lib/preview-mime";

describe("preview text line offset", () => {
  it("finds start offset for target line", () => {
    const text = "a\nbb\nccc\n";
    assert.equal(lineStartOffset(text, 1), 0);
    assert.equal(lineStartOffset(text, 2), 2);
    assert.equal(lineStartOffset(text, 3), 5);
    assert.equal(lineStartOffset(text, 99), text.length);
  });
});

describe("pdf highlight rects", () => {
  it("maps character offsets across space-joined text items", () => {
    const items = [
      { str: "Hello", transform: [1, 0, 0, 10, 0, 100], width: 50, height: 10 },
      { str: "World", transform: [1, 0, 0, 10, 60, 100], width: 50, height: 10 },
    ];
    // "Hello World" → highlight "Wor"
    const rects = highlightRectsForOffsets(
      items,
      (pdfRect) => pdfRect,
      6,
      9,
    );
    assert.equal(rects.length, 1);
    assert.ok(rects[0].width > 0);
    assert.ok(rects[0].left >= 60);
  });

  it("returns empty when range is empty", () => {
    assert.deepEqual(
      highlightRectsForOffsets(
        [{ str: "a", transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 }],
        (r) => r,
        2,
        2,
      ),
      [],
    );
  });

  it("maps normalized OCR bbox to page pixels", () => {
    const bbox = parsePreviewBbox([0.25, 0.5, 0.2, 0.1]);
    assert.ok(bbox);
    const rect = highlightRectForNormalizedBbox(bbox!, 800, 1200);
    assert.deepEqual(rect, {
      left: 200,
      top: 600,
      width: 160,
      height: 120,
    });
  });

  it("prefers bbox plan over offsets", () => {
    const plan = resolvePdfHighlightPlan({
      bbox: [0, 0, 0.1, 0.1],
      startOffset: 1,
      endOffset: 9,
    });
    assert.equal(plan.mode, "bbox");
  });

  it("only activates highlight on the cited page", () => {
    assert.equal(isHighlightPageActive(3, 3), true);
    assert.equal(isHighlightPageActive(4, 3), false);
    assert.equal(isHighlightPageActive(3, null), false);
    assert.equal(isHighlightPageActive(1, 0), false);
  });
});
