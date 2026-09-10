import assert from "node:assert/strict";
import test from "node:test";
import {
  detectKnowledgeKind,
  kindFromFileName,
  knowledgeFileAccept,
  officeFormatFromFileName,
  resolveKnowledgeFileKind,
  EXT_BY_OFFICE_FORMAT,
  KNOWLEDGE_FILE_ACCEPT_CORE,
  KNOWLEDGE_FILE_KIND_LABEL,
} from "../../services/knowledge/formats";
import { parseOfficeMarkdown } from "../../services/knowledge/parser";
import {
  applyOfficeImagePolicy,
  canonicalizeOfficeMarkdown,
} from "../../services/knowledge/office-markdown";
import {
  OFFICE_PRODUCT_CONTRACT,
  officePreviewBanner,
  officeWarningsToErrorMessage,
} from "../../services/knowledge/office-contract";
import { OFFICE_CONFIG } from "../../config/defaults";

test("formats: Office 扩展名识别为 office", () => {
  assert.equal(kindFromFileName("a.docx"), "office");
  assert.equal(kindFromFileName("b.PPTX"), "office");
  assert.equal(kindFromFileName("c.xlsx"), "office");
  assert.equal(kindFromFileName("book.epub"), "office");
  assert.equal(kindFromFileName("macro.docm"), "office");
  assert.equal(officeFormatFromFileName("deck.pptx"), "pptx");
  assert.equal(officeFormatFromFileName("old.xls"), "xlsx");
  assert.equal(officeFormatFromFileName("macro.xlsm"), "xlsx");
  assert.equal(officeFormatFromFileName("book.epub"), "epub");
  assert.equal(EXT_BY_OFFICE_FORMAT.xlsx, "xlsx");
  assert.equal(EXT_BY_OFFICE_FORMAT.docx, "docx");
  assert.ok(KNOWLEDGE_FILE_KIND_LABEL.includes("Office"));
  assert.ok(knowledgeFileAccept({ officeConverter: "anydoc" }).includes(".docx"));
  assert.ok(knowledgeFileAccept({ officeConverter: "anydoc" }).includes(".epub"));
  assert.equal(
    knowledgeFileAccept({ officeConverter: "none" }),
    KNOWLEDGE_FILE_ACCEPT_CORE,
  );
  assert.equal(
    knowledgeFileAccept(),
    KNOWLEDGE_FILE_ACCEPT_CORE,
  );
});

test("formats: ZIP 魔数 + docx 名 → office", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const kind = detectKnowledgeKind({
    fileName: "report.docx",
    buffer: zip.buffer,
  });
  assert.equal(kind, "office");
});

test("resolveKnowledgeFileKind: fileKind 优先，缺失时按路径", () => {
  assert.equal(
    resolveKnowledgeFileKind({
      fileKind: "pdf",
      paths: ["/tmp/a.docx"],
    }),
    "pdf",
  );
  assert.equal(
    resolveKnowledgeFileKind({
      fileKind: null,
      paths: ["/tmp/deck.pptx"],
    }),
    "office",
  );
  assert.equal(
    resolveKnowledgeFileKind({
      fileKind: "",
      paths: ["notes.markdown"],
    }),
    "md",
  );
});

test("parseOfficeMarkdown: Slide / Sheet 切页", () => {
  const slides = parseOfficeMarkdown(
    "## Slide 1\n\nHello\n\n## Slide 2\n\nWorld",
    "pptx",
  );
  assert.equal(slides.pageCount, 2);
  assert.match(slides.pages[0]?.text ?? "", /Slide 1/);

  const sheets = parseOfficeMarkdown(
    "## Sheet: A\n\n| x |\n| --- |\n| 1 |\n\n## Sheet: B\n\nok",
    "xlsx",
  );
  assert.equal(sheets.pageCount, 2);
  assert.match(sheets.pages[1]?.text ?? "", /Sheet: B/);
});

test("canonicalizeOfficeMarkdown: 补标题 + 截断 slide 并产生 warning", () => {
  const budget = {
    maxOutputChars: OFFICE_CONFIG.maxOutputChars,
    maxSlidesOrSheets: 2,
  };
  const ppt = canonicalizeOfficeMarkdown("only body", "pptx", budget);
  assert.match(ppt.markdown, /^## Slide 1/);
  assert.equal(ppt.warnings.length, 0);

  const many = canonicalizeOfficeMarkdown(
    "## Slide 1\n\na\n\n## Slide 2\n\nb\n\n## Slide 3\n\nc",
    "pptx",
    budget,
  );
  assert.equal(many.pageCountHint, 2);
  assert.equal(many.warnings[0]?.code, "sections_truncated");
  assert.equal(many.warnings[0]?.kept, 2);
  assert.equal(many.warnings[0]?.total, 3);
  assert.equal(
    officeWarningsToErrorMessage(many.warnings),
    "OFFICE_SECTIONS_TRUNCATED:2/3",
  );
  assert.doesNotMatch(many.markdown, /Slide 3/);

  const sheet = canonicalizeOfficeMarkdown("| a |\n| --- |\n| 1 |", "xlsx", budget);
  assert.match(sheet.markdown, /^## Sheet:/);
});

test("applyOfficeImagePolicy: 只保留 alt", () => {
  assert.equal(OFFICE_PRODUCT_CONTRACT.imagePolicy, "alt_text_only");
  assert.equal(OFFICE_CONFIG.materializeAssets, false);
  assert.equal(
    OFFICE_CONFIG.materializeAssets,
    OFFICE_PRODUCT_CONTRACT.materializeAssets,
  );
  const out = applyOfficeImagePolicy(
    "见 ![架构图](data:image/png;base64,xxx) 与 ![](http://x/a.png) 结束",
  );
  assert.match(out, /架构图/);
  assert.doesNotMatch(out, /data:image/);
  assert.doesNotMatch(out, /http:\/\/x/);
});

test("officePreviewBanner: 明确不含嵌入图", () => {
  assert.match(officePreviewBanner(), /不索引嵌入图片/);
  assert.match(officePreviewBanner(), /下载原件/);
});

test("anydoc adapter: csv 可转出 Markdown 表", async () => {
  const { createAnydocOfficeConverter } = await import(
    "../../services/knowledge/adapters/office-anydoc"
  );
  const converter = createAnydocOfficeConverter();
  const bytes = new TextEncoder().encode("name,qty\na,1\n");
  const sniffed = await converter.detectFormat(bytes, "csv");
  assert.equal(sniffed, "csv");
  const result = await converter.convert(bytes, { hint: "csv" });
  assert.equal(result.format, "csv");
  assert.match(result.markdown, /Sheet:/);
  assert.match(result.markdown, /name/);
  assert.ok(Array.isArray(result.warnings));
});

test("convert_office: 写入 IndexedText 后再 chunk", async () => {
  const { runConvertOfficeJob } = await import(
    "../../services/knowledge/processing/run-convert-office"
  );
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "orynode-office-preview-"));
  const docxPath = join(dir, "sample.csv");
  writeFileSync(docxPath, "name,qty\na,1\n", "utf8");
  let written = "";
  try {
    const result = await runConvertOfficeJob({
      payload: { namespace: "library", documentId: "doc-csv" },
      getDocumentMeta: () => ({
        storedPath: docxPath,
        fileKind: "office",
        name: "sample.csv",
        originalName: "sample.csv",
      }),
      writeIndexedText: (_ns, _id, markdown) => {
        written = markdown;
      },
      setDocumentStatus: async () => undefined,
      commitChunks: async () => undefined,
      compileMirror: async () => null,
    });
    assert.ok((result.chunkCount ?? 0) >= 1);
    assert.match(written, /Sheet:/);
    assert.match(written, /name/);
    const line = written.split("\n").findIndex((l) => l.includes("name"));
    assert.ok(line >= 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convert_office: 缺少 writeIndexedText 拒绝提交", async () => {
  const { runConvertOfficeJob } = await import(
    "../../services/knowledge/processing/run-convert-office"
  );
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "orynode-office-no-preview-"));
  const path = join(dir, "sample.csv");
  writeFileSync(path, "a,b\n1,2\n", "utf8");
  try {
    await assert.rejects(
      () =>
        runConvertOfficeJob({
          payload: { namespace: "library", documentId: "doc-csv-2" },
          getDocumentMeta: () => ({
            storedPath: path,
            fileKind: "office",
            name: "sample.csv",
            originalName: "sample.csv",
          }),
          setDocumentStatus: async () => undefined,
          commitChunks: async () => undefined,
        } as Parameters<typeof runConvertOfficeJob>[0]),
      /writeIndexedText/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convert_office: 非 office fileKind 拒绝", async () => {
  const { runConvertOfficeJob } = await import(
    "../../services/knowledge/processing/run-convert-office"
  );
  await assert.rejects(
    () =>
      runConvertOfficeJob({
        payload: { namespace: "library", documentId: "doc-pdf" },
        getDocumentMeta: () => ({
          storedPath: "/tmp/doc.pdf",
          fileKind: "pdf",
        }),
        writeIndexedText: () => undefined,
        setDocumentStatus: async () => undefined,
        commitChunks: async () => undefined,
      }),
    /CONVERT_OFFICE_WRONG_KIND:pdf/,
  );
});

test("产品硬禁止：OFFICE_CONFIG.allowCloudParse 必须为 false", () => {
  assert.equal(OFFICE_CONFIG.allowCloudParse, false);
});

test("Office 适配器源码不得出现 Firecrawl 云端 Parse 主机", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(process.cwd(), "services/knowledge");
  const files = [
    "adapters/office-anydoc.ts",
    "ports/office-converter.ts",
    "processing/run-convert-office.ts",
    "office-markdown.ts",
    "office-contract.ts",
  ];
  const banned = [
    /api\.firecrawl\.dev/i,
    /firecrawl\.dev\/(?:parse|v1)/i,
    /hosted\s*parse/i,
  ];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), "utf8");
    for (const pattern of banned) {
      assert.equal(
        pattern.test(text),
        false,
        `${rel} 不得包含云端 Parse 痕迹: ${pattern}`,
      );
    }
  }
});

test("anydoc adapter 不得调用 toDocument（避免物化 assets）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const text = readFileSync(
    join(process.cwd(), "services/knowledge/adapters/office-anydoc.ts"),
    "utf8",
  );
  assert.equal(
    /toDocument\s*\(/.test(text),
    false,
    "office-anydoc 不得调用 toDocument",
  );
});
