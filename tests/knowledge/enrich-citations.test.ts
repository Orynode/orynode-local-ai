import assert from "node:assert/strict";
import test from "node:test";
import type {
  Citation,
  CitationLocator,
} from "../../services/knowledge/core/types";

test("enrichCitations: 无来源映射时保持原 citation", async () => {
  const { enrichCitationsWithSourceLocators } = await import(
    "../../services/knowledge/context/enrich-citations"
  );
  const base: Citation = {
    id: "S1",
    documentId: "missing-doc",
    revisionId: "legacy",
    processingBuildId: "legacy",
    title: "Doc",
    sourceType: "file",
    locator: { kind: "text", startOffset: 0, endOffset: 10 },
    excerpt: "hello",
  };
  const out = await enrichCitationsWithSourceLocators([base]);
  assert.equal(out[0].locator.kind, "text");
  assert.equal(out[0].documentId, "missing-doc");
});

test("CitationLocator 联合类型覆盖 web/code", () => {
  const web: CitationLocator = {
    kind: "web",
    url: "https://example.com",
    headingPath: ["Title"],
  };
  const code: CitationLocator = {
    kind: "code",
    repo: "o/r",
    path: "a.ts",
    commit: "abc",
    startLine: 1,
    endLine: 10,
  };
  assert.equal(web.kind, "web");
  assert.equal(code.endLine, 10);
});
