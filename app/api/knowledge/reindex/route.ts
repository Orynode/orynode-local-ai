/**
 * POST /api/knowledge/reindex — 批量重建向量（开启语义后补齐旧文档）
 */

import { reindexAllDocuments } from "../../../../services/knowledge";

export async function POST() {
  try {
    const result = await reindexAllDocuments();
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "批量重建向量索引失败",
      },
      { status: 503 },
    );
  }
}
