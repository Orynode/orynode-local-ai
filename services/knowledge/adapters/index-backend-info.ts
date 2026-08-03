/**
 * Workers 安全的索引后端描述（不探测 sqlite-vec、不加载 adapters）
 */

export type IndexBackendId = "fts5+blob" | "sqlite-vec";

export function describeIndexBackend(): {
  id: IndexBackendId;
  keyword: "fts5";
  vector: "blob_scan" | "sqlite_vec";
  reason: string;
  sqliteVecAvailable: boolean;
} {
  return {
    id: "fts5+blob",
    keyword: "fts5",
    vector: "blob_scan",
    reason: "默认：FTS5 + BLOB 余弦扫描",
    sqliteVecAvailable: false,
  };
}
