"use client";

import { useCallback, useRef, useState } from "react";
import type { ConversationFile } from "../../services/types";
import {
  detectBrowserFileKind,
  mimeForKind,
} from "../../services/knowledge/formats";
import { MAX_KNOWLEDGE_FILE_SIZE } from "../../config/defaults";
import type { KnowledgeUploadState } from "./useKnowledge";

export type ConversationFileUploadResult = {
  file: ConversationFile;
  jobId?: string | null;
};

/**
 * 会话附件：绑 conversationId，不进资料库。
 * 需要持久保存时，请到资料库页面导入。
 */
export function useConversationFiles() {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<KnowledgeUploadState | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobTimers = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const stopJobTimers = useCallback(() => {
    for (const timer of jobTimers.current) clearInterval(timer);
    jobTimers.current.clear();
  }, []);

  const abortUpload = useCallback(() => {
    xhrRef.current?.abort();
    xhrRef.current = null;
  }, []);

  const refresh = useCallback(async (conversationId: string | null) => {
    conversationIdRef.current = conversationId;
    if (!conversationId) {
      setFiles([]);
      return [] as ConversationFile[];
    }
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/files`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error();
      const result = await response.json();
      const next: ConversationFile[] = result.files ?? [];
      setFiles(next);
      return next;
    } catch {
      setFiles([]);
      return [] as ConversationFile[];
    }
  }, []);

  const startStatusPolling = useCallback(
    (conversationId: string) => {
      stopPolling();
      let ticks = 0;
      pollTimer.current = setInterval(() => {
        ticks += 1;
        void refresh(conversationId).then((next) => {
          if (conversationIdRef.current !== conversationId) {
            stopPolling();
            return;
          }
          const pending = next.some(
            (file) =>
              file.status === "embedding" ||
              file.status === "awaiting_chunks" ||
              file.status === "stored" ||
              file.status === "processing",
          );
          if (!pending || ticks >= 120) {
            stopPolling();
          }
        });
      }, 1500);
    },
    [refresh, stopPolling],
  );

  const pollJobProgress = useCallback(
    (jobId: string, fileName: string, conversationId: string) => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        void fetch(`/api/knowledge/v1/jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
        })
          .then(async (response) => {
            if (!response.ok) return;
            if (conversationIdRef.current !== conversationId) {
              clearInterval(timer);
              jobTimers.current.delete(timer);
              return;
            }
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
              jobTimers.current.delete(timer);
              void refresh(conversationId);
            } else if (job?.status === "failed") {
              const err = String(job.error || "");
              setError(
                err.includes("OCR_UNAVAILABLE")
                  ? `OCR 不可用，原文件已保留：${fileName}`
                  : `识别失败：${fileName}`,
              );
              setNotice("");
              clearInterval(timer);
              jobTimers.current.delete(timer);
              void refresh(conversationId);
            }
          })
          .catch(() => undefined);
        if (ticks >= 120) {
          clearInterval(timer);
          jobTimers.current.delete(timer);
        }
      }, 1200);
      jobTimers.current.add(timer);
    },
    [refresh],
  );

  const clear = useCallback(() => {
    abortUpload();
    stopPolling();
    stopJobTimers();
    conversationIdRef.current = null;
    setFiles([]);
    setError("");
    setNotice("");
    setUploading(false);
    setUploadState(null);
  }, [abortUpload, stopJobTimers, stopPolling]);

  const upload = useCallback(
    async (
      conversationId: string,
      file: File,
    ): Promise<ConversationFileUploadResult | null> => {
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
      // 绑定目标会话，避免首挂附件时从未 refresh 导致误判为已取消
      conversationIdRef.current = conversationId;
      setUploadState({
        fileName: file.name,
        percent: 0,
        phase: "uploading",
      });

      try {
        const result = await new Promise<ConversationFileUploadResult>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhrRef.current = xhr;
            xhr.open(
              "POST",
              `/api/conversations/${encodeURIComponent(conversationId)}/files`,
            );
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
              if (xhr.status >= 200 && xhr.status < 300 && body.file) {
                resolve({
                  file: body.file as ConversationFile,
                  jobId: typeof body.jobId === "string" ? body.jobId : null,
                });
                return;
              }
              reject(
                new Error(
                  typeof body.error === "string" ? body.error : "上传失败",
                ),
              );
            };
            xhr.onerror = () => reject(new Error("会话附件上传失败"));
            xhr.onabort = () => reject(new Error("上传已取消"));
            xhr.send(file);
          },
        );

        if (conversationIdRef.current !== conversationId) {
          return null;
        }

        await refresh(conversationId);
        startStatusPolling(conversationId);
        if (result.jobId) {
          setNotice(`正在分析 PDF：${file.name}`);
          pollJobProgress(result.jobId, file.name, conversationId);
        }
        return result;
      } catch (e) {
        if (e instanceof Error && e.message === "上传已取消") {
          return null;
        }
        setError(e instanceof Error ? e.message : "会话附件上传失败");
        return null;
      } finally {
        xhrRef.current = null;
        setUploading(false);
        setUploadState(null);
      }
    },
    [pollJobProgress, refresh, startStatusPolling],
  );

  const remove = useCallback(
    async (conversationId: string, fileId: string) => {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setError("删除会话附件失败");
        return false;
      }
      await refresh(conversationId);
      return true;
    },
    [refresh],
  );

  const reindex = useCallback(
    async (conversationId: string, fileId: string) => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}/reindex`,
          { method: "POST" },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(
            typeof body.error === "string"
              ? body.error
              : "重建会话附件索引失败",
          );
          return false;
        }
        if (body.status === "error" || body.status === "skipped") {
          setError(
            typeof body.reason === "string"
              ? body.reason
              : "重建会话附件索引未完成",
          );
        }
        await refresh(conversationId);
        startStatusPolling(conversationId);
        return true;
      } catch {
        setError("重建会话附件索引失败");
        return false;
      }
    },
    [refresh, startStatusPolling],
  );

  return {
    files,
    uploading,
    uploadState,
    error,
    setError,
    notice,
    refresh,
    clear,
    abortUpload,
    upload,
    remove,
    reindex,
  };
}
