/**
 * sqlite-vec VectorIndex 占位（Phase 5 决策钩子）
 *
 * 未接入生产：isAvailable() 恒为 false，upsert/search 均抛错。
 * 即便本机已安装 sqlite-vec 包，registry / resolveIndexBackend 也不得选中本后端
 *（见 index-backend：生产固定 blob_scan）。
 * 启用前提：资料规模很大，且基准证明 BLOB 扫描成为瓶颈——不是默认升级路径。
 */

import type {
  EmbeddedChunk,
  IndexBuildRef,
  IndexCandidate,
  VectorIndex,
  VectorSearchOptions,
} from "../ports/indexes";
import { KnowledgeError } from "../core/errors";

export class SqliteVecVectorIndex implements VectorIndex {
  readonly backend = "sqlite-vec" as const;

  async isAvailable(): Promise<boolean> {
    // 实现完成前恒不可用，避免探测成功后选中占位后端
    return false;
  }

  async upsert(_build: IndexBuildRef, _vectors: EmbeddedChunk[]): Promise<void> {
    throw new KnowledgeError(
      "index_backend_unavailable",
      "sqlite-vec 尚未接入；请使用 blob_scan 或完成评测后再启用",
    );
  }

  async search(
    _vector: Float32Array,
    _options: VectorSearchOptions,
  ): Promise<IndexCandidate[]> {
    throw new KnowledgeError(
      "index_backend_unavailable",
      "sqlite-vec 尚未接入；请使用 blob_scan 或完成评测后再启用",
    );
  }
}
