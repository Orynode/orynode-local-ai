import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canReadConversationOriginal,
  canReadLibraryOriginal,
  conversationOriginalAccess,
  copyPreviewUpstreamHeaders,
  libraryOriginalAccess,
} from "../../app/lib/preview-file-auth";

describe("preview file authorization rules", () => {
  it("rejects missing library document", () => {
    assert.equal(canReadLibraryOriginal(false), false);
    assert.equal(canReadLibraryOriginal(true), true);
  });

  it("rejects conversation file scoped to another chat", () => {
    assert.equal(
      canReadConversationOriginal({
        pathConversationId: "c1",
        metaConversationId: "c2",
      }),
      false,
    );
    assert.equal(
      canReadConversationOriginal({
        pathConversationId: "c1",
        metaConversationId: "c1",
      }),
      true,
    );
    assert.equal(
      canReadConversationOriginal({
        pathConversationId: "c1",
        metaConversationId: null,
      }),
      false,
    );
  });

  it("maps library gate to 404 when missing", () => {
    assert.deepEqual(libraryOriginalAccess(false), {
      ok: false,
      status: 404,
      error: "资料不可用",
    });
    assert.deepEqual(libraryOriginalAccess(true), { ok: true });
  });

  it("maps conversation gate for wrong ownership and missing meta", () => {
    assert.equal(
      conversationOriginalAccess({
        pathConversationId: "c1",
        metaOk: true,
        metaConversationId: "c2",
      }).ok,
      false,
    );
    assert.equal(
      conversationOriginalAccess({
        pathConversationId: "c1",
        metaOk: false,
        metaConversationId: "c1",
      }).ok,
      false,
    );
    assert.deepEqual(
      conversationOriginalAccess({
        pathConversationId: "c1",
        metaOk: true,
        metaConversationId: "c1",
      }),
      { ok: true },
    );
  });

  it("copies upstream preview headers and forces no-store", () => {
    const upstream = new Headers({
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="a.pdf"',
      "x-file-name": "a.pdf",
      "content-length": "12",
      "cache-control": "public",
    });
    const headers = copyPreviewUpstreamHeaders(upstream);
    assert.equal(headers.get("content-type"), "application/pdf");
    assert.equal(headers.get("x-file-name"), "a.pdf");
    assert.equal(headers.get("content-length"), "12");
    assert.equal(headers.get("cache-control"), "no-store");
  });
});
