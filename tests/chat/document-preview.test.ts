import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPreviewFileUrl,
  previewIntentFromCitation,
  webUrlFromCitation,
} from "../../app/lib/document-preview";
import {
  looksLikePdf,
  previewKindFromMeta,
} from "../../app/lib/preview-mime";
import type { MessageCitation } from "../../services/types";

function citation(
  partial: Partial<MessageCitation> & Pick<MessageCitation, "id" | "documentId">,
): MessageCitation {
  return {
    revisionId: "legacy",
    processingBuildId: "legacy",
    title: "doc",
    sourceType: "library",
    locator: { kind: "page", page: 3 },
    excerpt: "hello",
    ...partial,
  };
}

describe("document-preview helpers", () => {
  it("builds library file url without client scope", () => {
    const url = buildPreviewFileUrl({
      documentId: "d1",
      sourceType: "library",
      page: 2,
    });
    assert.equal(url, "/api/knowledge/d1/file");
  });

  it("builds conversation file url with conversation binding", () => {
    const url = buildPreviewFileUrl({
      documentId: "f1",
      sourceType: "conversation_file",
      conversationId: "c1",
      page: 4,
    });
    assert.equal(url, "/api/conversations/c1/files/f1/content");
  });

  it("maps citation page locator and revision into preview intent", () => {
    const intent = previewIntentFromCitation(
      citation({
        id: "S1",
        documentId: "d1",
        revisionId: "rev-9",
        locator: { kind: "page", page: 9 },
      }),
      "c-ignore",
    );
    assert.equal(intent?.page, 9);
    assert.equal(intent?.sourceType, "library");
    assert.equal(intent?.revisionId, "rev-9");
    assert.equal(
      "processingBuildId" in (intent || {}),
      false,
    );
  });

  it("maps code locator startLine into preview intent", () => {
    const intent = previewIntentFromCitation(
      citation({
        id: "S1b",
        documentId: "d2",
        locator: { kind: "code", path: "a.ts", startLine: 42 },
      }),
    );
    assert.equal(intent?.startLine, 42);
  });

  it("maps page offsets and text locator into preview intent", () => {
    const pageIntent = previewIntentFromCitation(
      citation({
        id: "S4",
        documentId: "d4",
        locator: { kind: "page", page: 2, startOffset: 10, endOffset: 20 },
      }),
    );
    assert.equal(pageIntent?.page, 2);
    assert.equal(pageIntent?.startOffset, 10);
    assert.equal(pageIntent?.endOffset, 20);

    const textIntent = previewIntentFromCitation(
      citation({
        id: "S5",
        documentId: "d5",
        locator: { kind: "text", startOffset: 3, endOffset: 8 },
      }),
    );
    assert.equal(textIntent?.startOffset, 3);
    assert.equal(textIntent?.endOffset, 8);
  });

  it("maps OCR bbox from page locator into preview intent", () => {
    const intent = previewIntentFromCitation(
      citation({
        id: "S6",
        documentId: "d6",
        locator: {
          kind: "page",
          page: 1,
          bbox: [0.05, 0.1, 0.4, 0.08],
        },
      }),
    );
    assert.deepEqual(intent?.bbox, [0.05, 0.1, 0.4, 0.08]);
  });

  it("extracts web url for external open", () => {
    const c = citation({
      id: "S2",
      documentId: "w1",
      sourceType: "web",
      locator: { kind: "web", url: "https://example.com/a" },
    });
    assert.equal(webUrlFromCitation(c), "https://example.com/a");
  });

  it("rejects non-http(s) web locator urls", () => {
    const c = citation({
      id: "S3",
      documentId: "w2",
      sourceType: "web",
      locator: { kind: "web", url: "javascript:alert(1)" },
    });
    assert.equal(webUrlFromCitation(c), null);
  });
});

describe("preview-mime", () => {
  it("detects pdf from content-type even without extension", () => {
    assert.equal(
      previewKindFromMeta("application/pdf", "Nginx 教程"),
      "pdf",
    );
  });

  it("detects pdf from magic bytes when octet-stream", () => {
    const head = new TextEncoder().encode("%PDF-1.7\nrest");
    assert.equal(
      previewKindFromMeta("application/octet-stream", "noext", head),
      "pdf",
    );
    assert.equal(looksLikePdf(head), true);
  });

  it("detects markdown/text by extension", () => {
    assert.equal(previewKindFromMeta(null, "notes.md"), "text");
    assert.equal(previewKindFromMeta("text/plain", "a"), "text");
  });
});
