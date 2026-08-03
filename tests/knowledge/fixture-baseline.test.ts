/**
 * 用最小中英 fixture 锁定当前 keyword 召回行为（Phase 0 基线）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  extractSearchTerms,
  keywordScore,
} from "../../services/knowledge/retrieval/keyword";

type FixtureCase = {
  id: string;
  query: string;
  documents: Array<{
    id: string;
    name: string;
    chunks: string[];
  }>;
  relevantChunkSubstrings: string[];
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/rag/zh-en-baseline.json", import.meta.url),
    "utf8",
  ),
) as { cases: FixtureCase[] };

function rankChunks(query: string, contents: string[]) {
  const terms = extractSearchTerms(query);
  return contents
    .map((content, index) => ({
      index,
      content,
      score: keywordScore(content, terms),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}

for (const testCase of fixture.cases) {
  test(`fixture ${testCase.id}`, () => {
    const contents = testCase.documents.flatMap((doc) => doc.chunks);
    const ranked = rankChunks(testCase.query, contents);

    if (testCase.relevantChunkSubstrings.length === 0) {
      assert.equal(
        ranked.length,
        0,
        "无答案用例不应召回正分 chunk",
      );
      return;
    }

    assert.ok(ranked.length > 0, "应至少召回一个 chunk");
    const top = ranked[0]!.content;
    assert.ok(
      testCase.relevantChunkSubstrings.some((part) => top.includes(part)),
      `top chunk 未命中预期片段: ${top}`,
    );
  });
}
