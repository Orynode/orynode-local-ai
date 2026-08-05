import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDegradedReason,
  formatDegradedReasons,
  summarizeDegradedReasons,
} from "../../services/knowledge/retrieval/degraded-labels";
import { locatorFromHit } from "../../services/knowledge/context/build-context";
import type { RetrievalHit } from "../../services/knowledge/types";

test("degraded-labels: 稳定码转中文", () => {
  assert.match(
    formatDegradedReason("VECTOR_INDEX_NOT_READY"),
    /向量索引/,
  );
  assert.deepEqual(
    formatDegradedReasons([
      "SEMANTIC_SEARCH_DISABLED",
      "SEMANTIC_SEARCH_DISABLED",
      "RESOURCE_PRESSURE",
    ]),
    [
      formatDegradedReason("SEMANTIC_SEARCH_DISABLED"),
      formatDegradedReason("RESOURCE_PRESSURE"),
    ],
  );
  assert.match(summarizeDegradedReasons(["RERANKER_UNAVAILABLE"]), /重排/);
});

test("locatorFromHit: Markdown 忽略泛化 page hint，并从正文推断标题", () => {
  const hit = {
    id: "c1",
    documentId: "d1",
    documentName: "guide.md",
    pageNumber: 2,
    position: 0,
    content: "# 部署\n先安装依赖。",
    score: 1,
    source: "library" as const,
    locatorHint: { kind: "page" as const, page: 2 },
  } satisfies RetrievalHit;

  const locator = locatorFromHit(hit);
  assert.equal(locator.kind, "markdown");
  if (locator.kind === "markdown") {
    assert.deepEqual(locator.headingPath, ["部署"]);
  }
});
