/**
 * 向量索引后端决策（Phase 5）
 *
 * 当前产品决策固定为 blob_scan（SQLite BLOB + JS 余弦）。
 * sqlite-vec 仅保留 port / adapter 占位：不探测、不接受环境变量开启、不进入生产路径。
 * 仅当资料量很大、评测/基准证明扫描成为延迟或内存瓶颈时，再考虑替换此决策。
 */

import { SEARCH_CONFIG } from "../../../config/defaults";

export type IndexBackendId = "fts5+blob" | "sqlite-vec";

export type IndexBackendDecision = {
  id: IndexBackendId;
  keyword: "fts5";
  vector: "blob_scan" | "sqlite_vec";
  reason: string;
  sqliteVecAvailable: boolean;
};

/**
 * 解析当前应使用的索引后端。
 * 未来升级 sqlite-vec 时只需替换此决策与 adapter，上层无需改动。
 */
export async function resolveIndexBackend(): Promise<IndexBackendDecision> {
  return {
    id: "fts5+blob",
    keyword: "fts5",
    vector: "blob_scan",
    reason: SEARCH_CONFIG.semanticSearchEnabled
      ? "默认：FTS5 + BLOB 余弦扫描"
      : "默认：FTS5（语义未开启）",
    sqliteVecAvailable: false,
  };
}
