/**
 * 预览集成契约：citation → intent → 高亮计划 → 像素矩形，以及 API 鉴权/头复制链。
 * （无 RTL：以纯函数编排覆盖「组件级」关键路径，避免引入浏览器测试依赖。）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPreviewFileUrl,
  previewIntentFromCitation,
} from "../../app/lib/document-preview";
import {
  conversationOriginalAccess,
  copyPreviewUpstreamHeaders,
  libraryOriginalAccess,
} from "../../app/lib/preview-file-auth";
import {
  parsePreviewBbox,
  rectsForHighlightPlan,
  resolvePdfHighlightPlan,
} from "../../app/lib/preview-pdf-highlight";
import type { MessageCitation } from "../../services/types";

function citation(
  partial: Partial<MessageCitation> & Pick<MessageCitation, "id" | "documentId">,
): MessageCitation {
  return {
    revisionId: "legacy",
    processingBuildId: "legacy",
    title: "scan.pdf",
    sourceType: "library",
    locator: { kind: "page", page: 1 },
    excerpt: "hello",
    ...partial,
  };
}

describe("preview integration: OCR bbox highlight pipeline", () => {
  it("citation bbox flows to intent and paint rects (bbox wins over offsets)", () => {
    const intent = previewIntentFromCitation(
      citation({
        id: "S1",
        documentId: "doc-ocr",
        locator: {
          kind: "page",
          page: 3,
          startOffset: 0,
          endOffset: 99,
          bbox: [0.1, 0.2, 0.5, 0.1],
        },
      }),
    );
    assert.equal(intent?.page, 3);
    assert.deepEqual(intent?.bbox, [0.1, 0.2, 0.5, 0.1]);

    const plan = resolvePdfHighlightPlan({
      bbox: intent?.bbox,
      startOffset: intent?.startOffset,
      endOffset: intent?.endOffset,
    });
    assert.equal(plan.mode, "bbox");
    if (plan.mode !== "bbox") throw new Error("expected bbox plan");

    const rects = rectsForHighlightPlan(plan, {
      pageWidthPx: 1000,
      pageHeightPx: 2000,
    });
    assert.equal(rects.length, 1);
    assert.equal(rects[0].left, 100);
    assert.equal(rects[0].top, 400);
    assert.equal(rects[0].width, 500);
    assert.equal(rects[0].height, 200);
  });

  it("falls back to character offsets when bbox missing or invalid", () => {
    assert.equal(parsePreviewBbox([0.1, 0.2, 0, 0.1]), null);
    assert.equal(parsePreviewBbox("nope"), null);

    const plan = resolvePdfHighlightPlan({
      bbox: [NaN, 0, 0.1, 0.1],
      startOffset: 2,
      endOffset: 8,
    });
    assert.deepEqual(plan, { mode: "offsets", start: 2, end: 8 });

    const items = [
      { str: "ab", transform: [1, 0, 0, 10, 0, 50], width: 20, height: 10 },
      { str: "cdefgh", transform: [1, 0, 0, 10, 30, 50], width: 60, height: 10 },
    ];
    // "ab cdefgh" — offsets 2..8 cover space+cdef (join space at index 2)
    const rects = rectsForHighlightPlan(plan, {
      pageWidthPx: 800,
      pageHeightPx: 600,
      items,
      convertToViewportRectangle: (r) => r,
    });
    assert.ok(rects.length >= 1);
  });

  it("clamps out-of-range OCR bbox into the page", () => {
    const parsed = parsePreviewBbox([0.9, 0.9, 0.5, 0.5]);
    assert.ok(parsed);
    assert.ok(parsed![0] + parsed![2] <= 1 + 1e-9);
    assert.ok(parsed![1] + parsed![3] <= 1 + 1e-9);
  });
});

describe("preview integration: file API auth + headers contract", () => {
  it("library gate rejects missing meta before any bytes proxy", () => {
    const denied = libraryOriginalAccess(false);
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.status, 404);
      assert.match(denied.error, /资料/);
    }
  });

  it("conversation gate enforces path/meta conversation binding", () => {
    const denied = conversationOriginalAccess({
      pathConversationId: "chat-a",
      metaOk: true,
      metaConversationId: "chat-b",
    });
    assert.equal(denied.ok, false);

    const allowed = conversationOriginalAccess({
      pathConversationId: "chat-a",
      metaOk: true,
      metaConversationId: "chat-a",
    });
    assert.equal(allowed.ok, true);
  });

  it("builds scoped conversation URL and library URL without client scope", () => {
    assert.equal(
      buildPreviewFileUrl({
        documentId: "d1",
        sourceType: "library",
      }),
      "/api/knowledge/d1/file",
    );
    assert.equal(
      buildPreviewFileUrl({
        documentId: "f1",
        sourceType: "conversation_file",
        conversationId: "c1",
      }),
      "/api/conversations/c1/files/f1/content",
    );
  });

  it("HEAD/GET response headers always force no-store", () => {
    const headers = copyPreviewUpstreamHeaders(
      new Headers({
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent("扫描件.pdf"),
        "content-length": "2048",
        "cache-control": "max-age=3600",
      }),
    );
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("content-type"), "application/pdf");
    assert.equal(headers.get("content-length"), "2048");
  });
});
