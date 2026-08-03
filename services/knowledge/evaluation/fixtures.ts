/**
 * Fixture 加载与校验
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EvalCase,
  EvalChunk,
  EvalFixtureSet,
  EvalGatesConfig,
  RankerStrategyId,
} from "./types";

const CATEGORIES = new Set([
  "zh→zh",
  "en→en",
  "zh→en",
  "en→zh",
  "mixed",
  "zh-Hans↔zh-Hant",
  "exact",
  "paraphrase",
  "long_query",
  "conflict",
  "no_answer",
]);

export function defaultFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../tests/fixtures/rag/multilingual-p0.json");
}

export function defaultGatesPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../tests/fixtures/rag/gates.json");
}

export function loadFixtureSet(path = defaultFixturePath()): EvalFixtureSet {
  const raw = JSON.parse(readFileSync(path, "utf8")) as EvalFixtureSet;
  validateFixtureSet(raw);
  return raw;
}

export function loadGatesConfig(path = defaultGatesPath()): EvalGatesConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as EvalGatesConfig;
  if (!raw.thresholds || !raw.primaryStrategy) {
    throw new Error("gates.json 缺少 thresholds 或 primaryStrategy");
  }
  return raw;
}

export function validateFixtureSet(fixture: EvalFixtureSet): void {
  if (!fixture || typeof fixture.version !== "number") {
    throw new Error("fixture.version 无效");
  }
  if (!Array.isArray(fixture.corpus) || fixture.corpus.length === 0) {
    throw new Error("fixture.corpus 不能为空");
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error("fixture.cases 不能为空");
  }

  const chunkIds = new Set<string>();
  for (const chunk of fixture.corpus) {
    assertChunk(chunk);
    if (chunkIds.has(chunk.id)) {
      throw new Error(`重复 chunk id: ${chunk.id}`);
    }
    chunkIds.add(chunk.id);
  }

  const caseIds = new Set<string>();
  for (const item of fixture.cases) {
    assertCase(item, chunkIds);
    if (caseIds.has(item.id)) {
      throw new Error(`重复 case id: ${item.id}`);
    }
    caseIds.add(item.id);
  }

  const required = [
    "zh→zh",
    "en→en",
    "zh→en",
    "en→zh",
    "mixed",
    "zh-Hans↔zh-Hant",
    "exact",
    "paraphrase",
    "long_query",
    "conflict",
    "no_answer",
  ] as const;
  const present = new Set(fixture.cases.map((c) => c.category));
  for (const cat of required) {
    if (!present.has(cat)) {
      throw new Error(`fixture 缺少类别: ${cat}`);
    }
  }
}

function assertChunk(chunk: EvalChunk): void {
  if (!chunk?.id || !chunk.documentId || typeof chunk.text !== "string") {
    throw new Error(`无效 chunk: ${JSON.stringify(chunk)}`);
  }
}

function assertCase(item: EvalCase, chunkIds: Set<string>): void {
  if (!item?.id || !CATEGORIES.has(item.category) || !item.query) {
    throw new Error(`无效 case: ${JSON.stringify(item)}`);
  }
  if (!Array.isArray(item.relevantChunkIds)) {
    throw new Error(`case ${item.id} relevantChunkIds 必须是数组`);
  }
  for (const id of item.relevantChunkIds) {
    if (!chunkIds.has(id)) {
      throw new Error(`case ${item.id} 引用未知 chunk: ${id}`);
    }
  }
  if (item.expectNoAnswer && item.relevantChunkIds.length > 0) {
    throw new Error(`case ${item.id} expectNoAnswer 但 relevantChunkIds 非空`);
  }
  if (item.gateStrategies) {
    for (const s of item.gateStrategies) {
      assertStrategy(s);
    }
  }
}

function assertStrategy(s: string): asserts s is RankerStrategyId {
  const ok = [
    "keyword",
    "keyword_multilingual_fields",
    "multi_query",
    "lexical_rerank",
    "hybrid_rrf_lexical_stub",
  ].includes(s);
  if (!ok) throw new Error(`未知 strategy: ${s}`);
}
