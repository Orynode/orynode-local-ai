/**
 * 回归：pdf-dom-polyfill 的 Path2D stub 缺方法时，渲染带 path 的页会炸。
 * pdf-render 必须在 Node 侧挂上 @napi-rs/canvas 的 Path2D。
 */

import assert from "node:assert/strict";
import test from "node:test";
import "../../services/knowledge/pdf-dom-polyfill";
import {
  cleanupRenderTemp,
  renderPdfPageToPng,
} from "../../services/knowledge/processing/pdf-render";

/** 最小 PDF：一页 path（m/l/h/f），会走到 pdfjs constructPath → Path2D.moveTo */
function minimalPathPdf(): Uint8Array {
  const content = "100 0 m 100 100 l 0 100 l h f\n";
  const objects = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources<< >> >>endobj\n",
    `4 0 obj<< /Length ${content.length} >>stream\n${content}endstream\nendobj\n`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    xref +
    `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "utf8"));
}

test("pdf-render: Path2D stub is replaced; pages with draw paths render", async () => {
  const { Path2D: NapiPath2D } = await import("@napi-rs/canvas");
  assert.notEqual(
    globalThis.Path2D,
    NapiPath2D,
    "polyfill stub should be installed before render",
  );

  const rendered = await renderPdfPageToPng(minimalPathPdf(), 1, { dpi: 72 });
  try {
    assert.equal(globalThis.Path2D, NapiPath2D);
    assert.ok(rendered.bytes.byteLength > 100);
    assert.ok(rendered.width >= 1 && rendered.height >= 1);
  } finally {
    if (rendered.ownedTempDir) {
      await cleanupRenderTemp(rendered.tempDir);
    }
  }
});
