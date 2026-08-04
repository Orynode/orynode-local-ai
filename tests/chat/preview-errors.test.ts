import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  friendlyPdfError,
  friendlyPreviewLoadError,
} from "../../app/lib/preview-errors";
import {
  formatPreviewBytes,
  resolveOriginalFromResponse,
} from "../../app/lib/preview-mime";

describe("friendlyPreviewLoadError", () => {
  it("maps missing/forbidden to a clear access message", () => {
    assert.match(
      friendlyPreviewLoadError(new Error("无法打开原件：文件不存在")),
      /不存在|无权/,
    );
    assert.match(friendlyPreviewLoadError(new Error("404")), /不存在|无权/);
  });

  it("maps network failures to data-service guidance", () => {
    assert.match(
      friendlyPreviewLoadError(new Error("Failed to fetch")),
      /data-service/,
    );
  });

  it("keeps short safe messages and hides stack noise", () => {
    assert.equal(
      friendlyPreviewLoadError(new Error("无法读取文本原件")),
      "无法读取文本原件",
    );
    assert.equal(
      friendlyPreviewLoadError(new Error("Error\n    at webpack:///foo.js:1")),
      "打开原件失败，请稍后重试。",
    );
  });
});

describe("friendlyPdfError", () => {
  it("swallows cancel and maps corrupt/encrypted PDFs", () => {
    assert.equal(friendlyPdfError(new Error("Rendering cancelled")), "");
    assert.match(
      friendlyPdfError(new Error("Invalid PDF structure")),
      /损坏|密码/,
    );
  });

  it("maps worker load failures", () => {
    assert.match(
      friendlyPdfError(new Error("pdf.worker.min.mjs Failed to fetch")),
      /渲染组件|刷新/,
    );
  });
});

describe("formatPreviewBytes", () => {
  it("formats common sizes", () => {
    assert.equal(formatPreviewBytes(512), "512 B");
    assert.equal(formatPreviewBytes(2048), "2.0 KB");
    assert.equal(formatPreviewBytes(5 * 1024 * 1024), "5.0 MB");
  });
});

describe("resolveOriginalFromResponse", () => {
  it("buffers a small PDF from one streamed GET after magic peek", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n% small body");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdf);
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
    const resolved = await resolveOriginalFromResponse(response, {
      contentType: "application/octet-stream",
      fileName: "noext",
      contentLength: pdf.byteLength,
      textMaxBytes: 1024,
      pdfBufferMaxBytes: 1024 * 1024,
    });
    assert.equal(resolved.kind, "pdf");
    if (resolved.kind === "pdf") {
      assert.equal(resolved.mode, "data");
      if (resolved.mode === "data") {
        assert.equal(
          new TextDecoder().decode(new Uint8Array(resolved.data).subarray(0, 8)),
          "%PDF-1.4",
        );
      }
    }
  });

  it("falls back to url mode for large PDF after peek", async () => {
    const head = new TextEncoder().encode("%PDF-1.7\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        // leave stream open-ish then close; size claims large
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
    const resolved = await resolveOriginalFromResponse(response, {
      contentType: "application/octet-stream",
      fileName: "big",
      contentLength: 80 * 1024 * 1024,
      textMaxBytes: 1024,
      pdfBufferMaxBytes: 40 * 1024 * 1024,
    });
    assert.deepEqual(resolved, { kind: "pdf", mode: "url" });
  });

  it("reads truncated text without a second download", async () => {
    const body = "line1\nline2\n" + "x".repeat(200);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "text/plain" },
    });
    const resolved = await resolveOriginalFromResponse(response, {
      contentType: "text/plain",
      fileName: "notes.txt",
      contentLength: body.length,
      textMaxBytes: 20,
      pdfBufferMaxBytes: 1024,
    });
    assert.equal(resolved.kind, "text");
    if (resolved.kind === "text") {
      assert.equal(resolved.truncated, true);
      assert.ok(resolved.text.startsWith("line1"));
      assert.ok(resolved.text.length <= 20);
    }
  });
});
