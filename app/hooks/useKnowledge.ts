"use client";

import { useCallback, useRef, useState } from "react";
import type { KnowledgeDocument } from "../../services/types";
import {
  detectBrowserFileKind,
  mimeForKind,
} from "../../services/knowledge/formats";
import { MAX_KNOWLEDGE_FILE_SIZE } from "../../config/defaults";

export interface KnowledgeMeta {
  semanticSearchEnabled: boolean;
  embeddingModel: string;
  embeddingDim: number;
}

/** 上传进度（仅 UI；不表示对话选中） */
export type KnowledgeUploadState = {
  fileName: string;
  percent: number;
  phase: "uploading" | "processing";
};

function summarizeReindex(
  results: Array<{ id: string; status: string; reason?: string }>,
): { text: string; isError: boolean } {
  if (results.length === 0) {
    return { text: "没有可索引的文档", isError: false };
  }
  const skipped = results.filter((item) => item.status === "skipped");
  const indexed = results.filter((item) => item.status === "indexed");
  const errors = results.filter((item) => item.status === "error");

  if (skipped.length === results.length) {
    return {
      text: skipped[0]?.reason || "已跳过索引",
      isError: true,
    };
  }
  if (errors.length > 0 && indexed.length === 0) {
    return { text: `索引失败 ${errors.length} 篇`, isError: true };
  }
  if (indexed.length === results.length) {
    return { text: `已更新 ${indexed.length} 篇索引`, isError: false };
  }
  return {
    text:
      `已更新 ${indexed.length} 篇` +
      (errors.length ? `，失败 ${errors.length}` : "") +
      (skipped.length ? `，跳过 ${skipped.length}` : ""),
    isError: errors.length > 0,
  };
}

/**
 * 本地资料库：只负责文档仓库 CRUD / 上传 / 索引。
 * 对话「本轮附件」由页面 draftAttachments 管理，不在此粘性保存。
 */
export function useKnowledge() {
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

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/knowledge", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json();
      const next: KnowledgeDocument[] = result.documents ?? [];
      setDocuments(next);
      if (result.meta) {
        setMeta(result.meta as KnowledgeMeta);
      }
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取本地资料库");
      return [] as KnowledgeDocument[];
    }
  }, []);

  const startStatusPolling = useCallback(() => {
    stopPolling();
    let ticks = 0;
    pollTimer.current = setInterval(() => {
      ticks += 1;
      void refresh().then((docs) => {
        const pending = docs.some(
          (doc) =>
            doc.status === "embedding" || doc.status === "awaiting_chunks",
        );
        if (!pending || ticks >= 40) {
          stopPolling();
        }
      });
    }, 1500);
  }, [refresh, stopPolling]);

  const upload = useCallback(
    async (file: File): Promise<KnowledgeDocument | null> => {
      const kind = detectBrowserFileKind(file);
      if (!kind) {
        setError("目前只支持 PDF、TXT、Markdown（.md）文件");
        return null;
      }
      if (file.size > MAX_KNOWLEDGE_FILE_SIZE) {
        setError("文件不能超过 50 MB");
        return null;
      }

      setUploading(true);
      setError("");
      setNotice("");
      setUploadState({
        fileName: file.name,
        percent: 0,
        phase: "uploading",
      });

      try {
        const result = await new Promise<{ document: KnowledgeDocument }>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/knowledge");
            xhr.setRequestHeader("content-type", mimeForKind(kind));
            xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
            xhr.setRequestHeader("x-file-kind", kind);
            xhr.responseType = "json";

            xhr.upload.onprogress = (event) => {
              if (!event.lengthComputable) return;
              const percent = Math.max(
                0,
                Math.min(99, Math.round((event.loaded / event.total) * 100)),
              );
              setUploadState({
                fileName: file.name,
                percent,
                phase: "uploading",
              });
            };

            xhr.upload.onload = () => {
              setUploadState({
                fileName: file.name,
                percent: 100,
                phase: "processing",
              });
            };

            xhr.onload = () => {
              const body = xhr.response ?? {};
              if (xhr.status >= 200 && xhr.status < 300 && body.document) {
                resolve(body as { document: KnowledgeDocument });
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
        startStatusPolling();
        return result.document;
      } catch (e) {
        setError(e instanceof Error ? e.message : "资料导入失败");
        return null;
      } finally {
        setUploading(false);
        setUploadState(null);
      }
    },
    [refresh, startStatusPolling],
  );

  const remove = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setError("删除失败");
        return;
      }
      await refresh();
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
        if (result.status === "skipped") {
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
    [flash, refresh, startStatusPolling],
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
      await refresh();
      startStatusPolling();
    } catch (e) {
      flash(e instanceof Error ? e.message : "批量重建失败", true);
    } finally {
      setReindexing(false);
    }
  }, [flash, refresh, startStatusPolling]);

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
    remove,
    reindex,
    reindexAll,
  };
}
