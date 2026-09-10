/**
 * 入队 compile_wiki。策略仍在 Job 里；这里只打 data-service。
 * parseWikiCompileForce 是 App Router 与 Job payload 共用的 force 契约。
 * 幂等键不含 force：data-service 会把新 payload（含 force）合并进在途/终态任务。
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";

export function parseWikiCompileForce(body: unknown): {
  force: boolean;
  confirmForce: boolean;
} {
  const posted =
    body && typeof body === "object"
      ? (body as { force?: boolean; confirmForce?: boolean })
      : {};
  return {
    force: posted.force === true,
    confirmForce: posted.confirmForce === true,
  };
}

export function wikiForceBlocked(
  page: { userEdited?: boolean } | null | undefined,
  force: boolean,
  confirmForce: boolean,
): boolean {
  return Boolean(page?.userEdited) && force && !confirmForce;
}

export const WIKI_FORCE_CONFIRM_ERROR = "这一页已人手改过，确认覆盖后再重新生成";

export async function enqueueCompileWikiJob(input: {
  namespace: "library" | "conversation";
  documentId: string;
  pageId?: string;
  title?: string;
  force?: boolean;
}): Promise<{ jobId: string; status: string }> {
  const documentId = String(input.documentId || "").trim();
  const pageId = String(input.pageId || "").trim();
  if (!documentId && !pageId) {
    throw new Error("compile_wiki 缺少 pageId 或 documentId");
  }
  const key = `compile_wiki:${input.namespace}:${pageId || documentId}`;
  const enqueue = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "compile_wiki",
      idempotencyKey: key,
      payload: {
        namespace: input.namespace,
        documentId,
        ...(pageId ? { pageId } : {}),
        ...(input.title ? { title: input.title } : {}),
        force: Boolean(input.force),
      },
      maxAttempts: 2,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  const body = (await enqueue.json().catch(() => ({}))) as {
    job?: { id?: string; status?: string };
    error?: string;
  };
  if (!enqueue.ok || !body.job?.id) {
    const error = new Error(body.error || "无法开始生成综述");
    (error as Error & { status?: number }).status =
      enqueue.status === 400 || enqueue.status === 429
        ? enqueue.status
        : 502;
    throw error;
  }
  return { jobId: body.job.id, status: String(body.job.status || "queued") };
}
