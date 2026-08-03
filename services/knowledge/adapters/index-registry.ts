/**
 * Index Adapter Registry — 上层只依赖 KeywordIndex / VectorIndex
 */

import type { KeywordIndex, VectorIndex } from "../ports/indexes";
import { Fts5KeywordIndex } from "./keyword-fts5";
import { BlobScanVectorIndex } from "./vector-blob-scan";
import { SqliteVecVectorIndex } from "./vector-sqlite-vec";
import {
  resolveIndexBackend,
  type IndexBackendDecision,
} from "./index-backend";
import { SQLiteVectorStore } from "../vector-store";

export type ResolvedIndexes = {
  keyword: KeywordIndex;
  vector: VectorIndex;
  decision: IndexBackendDecision;
};

let cached: ResolvedIndexes | null = null;

export async function resolveIndexes(
  options: { forceRefresh?: boolean } = {},
): Promise<ResolvedIndexes> {
  if (cached && !options.forceRefresh) return cached;

  const decision = await resolveIndexBackend();
  const keyword = new Fts5KeywordIndex();
  let vector: VectorIndex = new BlobScanVectorIndex(new SQLiteVectorStore());

  if (decision.vector === "sqlite_vec") {
    const candidate = new SqliteVecVectorIndex();
    if (await candidate.isAvailable()) {
      vector = candidate;
    } else {
      decision.vector = "blob_scan";
      decision.id = "fts5+blob";
      decision.reason = "sqlite-vec 探测失败，回退 blob_scan";
      decision.sqliteVecAvailable = false;
    }
  }

  cached = { keyword, vector, decision };
  return cached;
}

/** 测试用：清空缓存 */
export function resetIndexRegistry(): void {
  cached = null;
}

export {
  Fts5KeywordIndex,
  BlobScanVectorIndex,
  SqliteVecVectorIndex,
  resolveIndexBackend,
};
