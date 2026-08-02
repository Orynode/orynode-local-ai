"use client";

import { useCallback, useState } from "react";
import type { ConversationFile } from "../../services/types";
import {
  detectBrowserFileKind,
  mimeForKind,
} from "../../services/knowledge/formats";
import { MAX_KNOWLEDGE_FILE_SIZE } from "../../config/defaults";
import type { KnowledgeUploadState } from "./useKnowledge";

/**
 * 会话附件：绑 conversationId，不进资料库。
 * 需要持久保存时，由用户走「导入资料库」。
 */
export function useConversationFiles() {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<KnowledgeUploadState | null>(
    null,
  );
  const [error, setError] = useState("");

  const refresh = useCallback(async (conversationId: string | null) => {
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

  const clear = useCallback(() => {
    setFiles([]);
    setError("");
  }, []);

  const upload = useCallback(
    async (
      conversationId: string,
      file: File,
    ): Promise<ConversationFile | null> => {
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
      setUploadState({
        fileName: file.name,
        percent: 0,
        phase: "uploading",
      });

      try {
        const result = await new Promise<{ file: ConversationFile }>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
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
                resolve(body as { file: ConversationFile });
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

        await refresh(conversationId);
        return result.file;
      } catch (e) {
        setError(e instanceof Error ? e.message : "会话附件上传失败");
        return null;
      } finally {
        setUploading(false);
        setUploadState(null);
      }
    },
    [refresh],
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
        return true;
      } catch {
        setError("重建会话附件索引失败");
        return false;
      }
    },
    [refresh],
  );

  return {
    files,
    uploading,
    uploadState,
    error,
    setError,
    refresh,
    clear,
    upload,
    remove,
    reindex,
  };
}
