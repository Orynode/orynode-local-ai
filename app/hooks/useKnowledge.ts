"use client";

import { useCallback, useRef, useState } from "react";
import type { KnowledgeDocument } from "../../services/types";
import {
  detectBrowserFileKind,
  mimeForKind,
} from "../../services/knowledge/formats";
import {
  MAX_KNOWLEDGE_FILE_SIZE,
  MAX_KNOWLEDGE_FILE_SIZE_LABEL,
} from "../../config/defaults";

export interface KnowledgeMeta {
  semanticSearchEnabled: boolean;
  embeddingModel: string;
  embeddingDim: number;
}

/** 上传进度（仅 UI；不表示对话选中） */
export type KnowledgeUploadState = {
  fileName: string;
  percent: number;
  phase: "uploading" | "processing" | "ocr";
  detail?: string;
};

export type KnowledgeUploadResult = {
  document: KnowledgeDocument;
  deduplicated: boolean;
  jobId?: string | null;
};

function summarizeReindex(
  results: Array<{ id: string; status: string; reason?: string }>,
): { text: string; isError: boolean } {
  if (results.length === 0) {
    return { text: "没有可索引的文档", isError: false };
  }
  const queued = results.filter((item) => item.status === "queued");
  const skipped = results.filter((item) => item.status === "skipped");
  const indexed = results.filter((item) => item.status === "indexed");
  const errors = results.filter((item) => item.status === "error");

  if (queued.length === results.length) {
    return {
      text: `已入队后台重建 ${queued.length} 篇（可继续关键词检索）`,
      isError: false,
    };
  }
  if (skipped.length === results.length) {
    return {
      text: skipped[0]?.reason || "已跳过索引",
      isError: true,
    };
  }
  if (errors.length > 0 && indexed.length === 0 && queued.length === 0) {
    return { text: `索引失败 ${errors.length} 篇`, isError: true };
  }
  if (indexed.length === results.length) {
    return { text: `已更新 ${indexed.length} 篇索引`, isError: false };
  }
  return {
    text:
      (queued.length ? `已入队 ${queued.length} 篇` : "") +
      (indexed.length
        ? `${queued.length ? "，" : ""}已更新 ${indexed.length} 篇`
        : "") +
      (errors.length ? `，失败 ${errors.length}` : "") +
      (skipped.length ? `，跳过 ${skipped.length}` : ""),
    isError: errors.length > 0,
  };
}

/**
 * 本地资料库：CRUD / 上传（内容去重）/ 显示名重命名 / 索引。
 * 会话附件见 useConversationFiles；本轮检索选中见 draftAttachments。
 */
export function useKnowledge(options?: { onJobsChanged?: () => void }) {
  const onJobsChanged = options?.onJobsChanged;
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [meta, setMeta] = useState<KnowledgeMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<KnowledgeUploadState | null>(
    null,
  );
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFlash = useCallback(() => {
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
      flashTimer.current = null;
    }
  }, []);

  const flash = useCallback(
    (message: string, asError = false) => {
      clearFlash();
      if (asError) {
        setError(message);
        setNotice("");
      } else {
        setNotice(message);
        setError("");
      }
      flashTimer.current = setTimeout(() => {
        setNotice("");
        if (asError) setError("");
        flashTimer.current = null;
      }, 3200);
    },
    [clearFlash],
  );

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<KnowledgeDocument[] | null> => {
    try {
      const response = await fetch("/api/knowledge", { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof result.error === "string" && result.error.trim()
            ? result.error
            : "无法读取本地资料库";
        setError(message);
        // 瞬时失败（如向量重建占满 data-service）不清空已有列表
        return null;
      }
      const next: KnowledgeDocument[] = result.documents ?? [];
      setDocuments(next);
      setError("");
      if (result.meta) {
        setMeta(result.meta as KnowledgeMeta);
        if (result.meta.semanticSearchEnabled) {
          // 触发节流补建；失败不影响列表
          void fetch("/api/knowledge/vector-backfill", { method: "POST" }).catch(
            () => undefined,
          );
        }
      }
      return next;
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "无法读取本地资料库",
      );
      return null;
    }
  }, []);

  const startStatusPolling = useCallback(() => {
    stopPolling();
    let ticks = 0;
    pollTimer.current = setInterval(() => {
      ticks += 1;
      void refresh().then((docs) => {
        if (!docs) {
          // 读失败时继续轮询，避免向量重建期间一次超时就停
          if (ticks >= 120) stopPolling();
          return;
        }
        const pending = docs.some(
          (doc) =>
            doc.status === "embedding" ||
            doc.status === "awaiting_chunks" ||
            doc.status === "stored" ||
            doc.status === "processing",
        );
        if (!pending || ticks >= 120) {
          stopPolling();
        }
      });
    }, 1500);
  }, [refresh, stopPolling]);

  const pollJobProgress = useCallback(
    (jobId: string, fileName: string) => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        void fetch(`/api/knowledge/v1/jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
        })
          .then(async (response) => {
            if (!response.ok) return;
            const body = await response.json().catch(() => ({}));
            const job = body.job ?? body;
            const progress = job?.progress;
            if (progress?.phase === "analyzing") {
              setNotice(`正在分析 PDF：${fileName}`);
            } else if (
              progress?.phase === "ocr" &&
              typeof progress.ocrPagesCompleted === "number" &&
              typeof progress.ocrPagesTotal === "number"
            ) {
              setNotice(
                `正在识别扫描页 ${progress.ocrPagesCompleted}/${progress.ocrPagesTotal}：${fileName}`,
              );
            } else if (
              job?.status === "succeeded" ||
              progress?.phase === "keyword_index"
            ) {
              setNotice(`已完成，可关键词检索：${fileName}`);
              clearInterval(timer);
              void refresh();
            } else if (job?.status === "failed") {
              const err = String(job.error || "");
              setError(
                err.includes("OCR_UNAVAILABLE")
                  ? `OCR 不可用，原文件已保留：${fileName}`
                  : `识别失败：${fileName}`,
              );
              setNotice("");
              clearInterval(timer);
              void refresh();
            }
          })
          .catch(() => undefined);
        if (ticks >= 120) clearInterval(timer);
      }, 1200);
    },
    [refresh],
  );

  const upload = useCallback(
    async (
      file: File,
      options?: { displayName?: string },
    ): Promise<KnowledgeUploadResult | null> => {
      const kind = detectBrowserFileKind(file);
      if (!kind) {
        setError("目前只支持 PDF、TXT、Markdown（.md）文件");
        return null;
      }
      if (file.size > MAX_KNOWLEDGE_FILE_SIZE) {
        setError(`文件不能超过 ${MAX_KNOWLEDGE_FILE_SIZE_LABEL}`);
        return null;
      }

      const label = options?.displayName?.trim() || file.name;
      setUploading(true);
      setError("");
      setNotice("");
      setUploadState({
        fileName: label,
        percent: 0,
        phase: "uploading",
      });

      try {
        const result = await new Promise<KnowledgeUploadResult>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/knowledge");
            xhr.setRequestHeader("content-type", mimeForKind(kind));
            xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
            if (options?.displayName?.trim()) {
              xhr.setRequestHeader(
                "x-display-name",
                encodeURIComponent(options.displayName.trim()),
              );
            }
            xhr.setRequestHeader("x-file-kind", kind);
            xhr.responseType = "json";

            xhr.upload.onprogress = (event) => {
              if (!event.lengthComputable) return;
              const percent = Math.max(
                0,
                Math.min(99, Math.round((event.loaded / event.total) * 100)),
              );
              setUploadState({
                fileName: label,
                percent,
                phase: "uploading",
              });
            };

            xhr.upload.onload = () => {
              setUploadState({
                fileName: label,
                percent: 100,
                phase: "processing",
              });
            };

            xhr.onload = () => {
              const body = xhr.response ?? {};
              if (xhr.status >= 200 && xhr.status < 300 && body.document) {
                resolve({
                  document: body.document as KnowledgeDocument,
                  deduplicated: Boolean(body.deduplicated),
                  jobId: typeof body.jobId === "string" ? body.jobId : null,
                });
                return;
              }
              reject(
                new Error(
                  typeof body.error === "string" ? body.error : "导入失败",
                ),
              );
            };
            xhr.onerror = () => reject(new Error("资料导入失败"));
            xhr.onabort = () => reject(new Error("上传已取消"));
            xhr.send(file);
          },
        );

        await refresh();
        if (!result.deduplicated) {
          startStatusPolling();
          if (result.jobId) {
            flash(`正在分析 PDF：${label}`);
            pollJobProgress(result.jobId, label);
            onJobsChanged?.();
          } else if (
            result.document.status === "ready" ||
            result.document.status === "indexed" ||
            !result.document.status
          ) {
            flash(`已完成，可关键词检索：${label}`);
          }
        }
        // 去重提示由页面弹窗展示（顶部 notice 在对话页不可见）
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : "资料导入失败");
        return null;
      } finally {
        setUploading(false);
        setUploadState(null);
      }
    },
    [flash, onJobsChanged, pollJobProgress, refresh, startStatusPolling],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<KnowledgeDocument | null> => {
      const trimmed = name.trim();
      if (!trimmed) {
        flash("显示名称不能为空", true);
        return null;
      }
      try {
        const response = await fetch(
          `/api/knowledge/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          flash(
            typeof body.error === "string" ? body.error : "重命名失败",
            true,
          );
          return null;
        }
        await refresh();
        flash("已更新显示名称");
        return body.document as KnowledgeDocument;
      } catch {
        flash("重命名失败", true);
        return null;
      }
    },
    [flash, refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError("删除失败");
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const reindex = useCallback(
    async (id: string) => {
      setReindexing(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(
          `/api/knowledge/${encodeURIComponent(id)}/reindex`,
          { method: "POST" },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "重建索引失败");
        if (result.status === "queued") {
          flash(result.reason || "已入队后台向量重建");
          onJobsChanged?.();
        } else if (result.status === "skipped") {
          flash(result.reason || "已跳过索引", true);
        } else if (result.status === "indexed") {
          flash("索引已更新");
        } else if (result.status === "error") {
          flash(result.reason || "索引失败", true);
        } else {
          flash(`结果：${result.status}`);
        }
        await refresh();
        startStatusPolling();
      } catch (e) {
        flash(e instanceof Error ? e.message : "重建索引失败", true);
      } finally {
        setReindexing(false);
      }
    },
    [flash, onJobsChanged, refresh, startStatusPolling],
  );

  const reprocess = useCallback(
    async (id: string) => {
      setReindexing(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(
          `/api/knowledge/${encodeURIComponent(id)}/reprocess`,
          { method: "POST" },
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof result.error === "string" ? result.error : "重试识别失败",
          );
        }
        flash("正在重新识别扫描页…");
        if (typeof result.jobId === "string") {
          const doc = documents.find((d) => d.id === id);
          pollJobProgress(result.jobId, doc?.name || id);
          onJobsChanged?.();
        }
        await refresh();
        startStatusPolling();
      } catch (e) {
        flash(e instanceof Error ? e.message : "重试识别失败", true);
      } finally {
        setReindexing(false);
      }
    },
    [documents, flash, onJobsChanged, pollJobProgress, refresh, startStatusPolling],
  );

  const reindexAll = useCallback(async () => {
    setReindexing(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/knowledge/reindex", {
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "批量重建失败");
      const summary = summarizeReindex(result.results ?? []);
      flash(summary.text, summary.isError);
      if (
        Array.isArray(result.results) &&
        result.results.some(
          (item: { status?: string }) => item.status === "queued",
        )
      ) {
        onJobsChanged?.();
      }
      await refresh();
      startStatusPolling();
    } catch (e) {
      flash(e instanceof Error ? e.message : "批量重建失败", true);
    } finally {
      setReindexing(false);
    }
  }, [flash, onJobsChanged, refresh, startStatusPolling]);

  const importWeb = useCallback(
    async (url: string) => {
      setUploading(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch("/api/knowledge/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "web", url }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "网页导入失败");
        const sync = result.result;
        flash(
          `网页已同步：新增 ${sync.imported}，更新 ${sync.updated}，不变 ${sync.unchanged}` +
            (sync.errors?.length ? `，失败 ${sync.errors.length}` : ""),
          Boolean(sync.errors?.length),
        );
        onJobsChanged?.();
        await refresh();
        startStatusPolling();
      } catch (e) {
        flash(e instanceof Error ? e.message : "网页导入失败", true);
      } finally {
        setUploading(false);
      }
    },
    [flash, onJobsChanged, refresh, startStatusPolling],
  );

  const importGitHub = useCallback(
    async (input: {
      owner: string;
      repo: string;
      ref?: string;
      pathPrefix?: string;
      token?: string;
    }) => {
      setUploading(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch("/api/knowledge/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "github", ...input }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "GitHub 同步失败");
        const sync = result.result;
        flash(
          `GitHub 已同步：新增 ${sync.imported}，更新 ${sync.updated}，不变 ${sync.unchanged}` +
            (sync.tombstoned ? `，标记删除 ${sync.tombstoned}` : "") +
            (sync.errors?.length ? `，失败 ${sync.errors.length}` : ""),
          Boolean(sync.errors?.length),
        );
        onJobsChanged?.();
        await refresh();
        startStatusPolling();
      } catch (e) {
        flash(e instanceof Error ? e.message : "GitHub 同步失败", true);
      } finally {
        setUploading(false);
      }
    },
    [flash, onJobsChanged, refresh, startStatusPolling],
  );

  return {
    documents,
    meta,
    uploading,
    uploadState,
    reindexing,
    error,
    notice,
    refresh,
    upload,
    rename,
    remove,
    reindex,
    reprocess,
    reindexAll,
    importWeb,
    importGitHub,
  };
}
