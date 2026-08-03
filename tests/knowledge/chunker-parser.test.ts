import assert from "node:assert/strict";
import test from "node:test";
import { createChunker } from "../../services/knowledge/chunker";
import { parsePlainText } from "../../services/knowledge/parser";
import {
  hashContent,
  isUsableLibraryDocument,
  resolveDisplayName,
} from "../../services/knowledge/hash";

test("parsePlainText: Markdown 标题切页", () => {
  const text = "# 标题一\n内容 A\n\n## 标题二\n内容 B";
  const buffer = new TextEncoder().encode(text).buffer;
  const doc = parsePlainText(buffer, "md");
  assert.ok(doc.pageCount >= 2);
  assert.match(doc.pages[0]!.text, /标题一/);
  assert.match(doc.pages[1]!.text, /标题二/);
});

test("parsePlainText: 空文档", () => {
  const buffer = new TextEncoder().encode("   ").buffer;
  const doc = parsePlainText(buffer, "txt");
  assert.equal(doc.pageCount, 0);
});

test("chunker: 短文不分块", () => {
  const chunker = createChunker({
    maxChunkSize: 1800,
    minChunkSize: 200,
    overlapSize: 200,
    separators: ["\n\n", "\n", "。", " "],
  });
  const chunks = chunker.chunkDocument([
    { pageNumber: 1, text: "这是一段足够短的文本。" },
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.pageNumber, 1);
});

test("chunker: 长文按分隔符切开", () => {
  const chunker = createChunker({
    maxChunkSize: 40,
    minChunkSize: 10,
    overlapSize: 5,
    separators: ["\n\n", "\n", "。", " "],
  });
  const text = Array.from({ length: 8 }, (_, i) => `段落${i}：${"内容".repeat(8)}。`).join(
    "\n\n",
  );
  const chunks = chunker.chunkDocument([{ pageNumber: 1, text }]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.length > 0));
});

test("hashContent: 稳定 SHA-256", () => {
  const bytes = new TextEncoder().encode("hello-orynode");
  const a = hashContent(bytes);
  const b = hashContent(bytes);
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("isUsableLibraryDocument / resolveDisplayName", () => {
  assert.equal(isUsableLibraryDocument({ status: "ready", chunkCount: 3 }), true);
  assert.equal(
    isUsableLibraryDocument({ status: "awaiting_chunks", chunkCount: 0 }),
    false,
  );
  assert.equal(
    isUsableLibraryDocument({ status: "processing", chunkCount: 0 }),
    false,
  );
  assert.equal(
    isUsableLibraryDocument({ status: "processing_error", chunkCount: 0 }),
    false,
  );
  assert.equal(resolveDisplayName("  我的资料  ", "a.pdf"), "我的资料");
  assert.equal(resolveDisplayName("", "a.pdf"), "a.pdf");
});
