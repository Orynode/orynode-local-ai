"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type KnowledgeJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled";

export type KnowledgeJob = {
  id: string;
  type: string;
  status: KnowledgeJobStatus;
  attempts: number;
  maxAttempts: number;
  progress?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  documentId?: string | null;
  documentName?: string | null;
  namespace?: string | null;
  payload?: Record<string, unknown>;
};

export type KnowledgeJobsSummary = {
  queued: number;
  running: number;
  retryWait: number;
  failedRecent: number;
  active: number;
};

const EMPTY_SUMMARY: KnowledgeJobsSummary = {
  queued: 0,
  running: 0,
  retryWait: 0,
  failedRecent: 0,
  active: 0,
};

export const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "running",
  "retry_wait",
]);

export function isActiveJobStatus(status: string): boolean {
  return ACTIVE_JOB_STATUSES.has(status);
}

export function partitionKnowledgeJobs(jobs: KnowledgeJob[]): {
  activeJobs: KnowledgeJob[];
  recentJobs: KnowledgeJob[];
} {
  const activeJobs: KnowledgeJob[] = [];
  const recentJobs: KnowledgeJob[] = [];
  for (const job of jobs) {
    if (isActiveJobStatus(job.status)) activeJobs.push(job);
    else recentJobs.push(job);
  }
  return { activeJobs, recentJobs };
}

export function jobTypeLabel(type: string): string {
  switch (type) {
    case "embed_document":
      return "向量重建";
    case "process_revision":
      return "PDF/OCR 处理";
    case "sync_source":
      return "来源同步";
    case "garbage_collect":
      return "清理";
    default:
      return type;
  }
}

export function jobStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "进行中";
    case "retry_wait":
      return "等待重试";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function formatJobProgress(
  progress: Record<string, unknown> | null | undefined,
): string {
  if (!progress || typeof progress !== "object") return "";
  const phase = typeof progress.phase === "string" ? progress.phase : "";
  if (
    typeof progress.done === "number" &&
    typeof progress.total === "number" &&
    progress.total > 0
  ) {
    return `${phase || "进度"} ${progress.done}/${progress.total}`;
  }
  if (
    typeof progress.ocrPagesCompleted === "number" &&
    typeof progress.ocrPagesTotal === "number"
  ) {
    return `OCR ${progress.ocrPagesCompleted}/${progress.ocrPagesTotal}`;
  }
  if (phase === "analyzing") return "分析中";
  if (phase === "embedding") return "向量化中";
  if (phase === "keyword_index") return "关键词索引";
  if (phase === "chunking") return "分块中";
  return phase;
}

/**
 * 资料库处理中心：拉取 / 轮询全局 Job 队列。
 * 轮询仅在有 active 任务时持续；空闲后停止，避免「一直在更新」的错觉。
 */
export function useKnowledgeJobs() {
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [summary, setSummary] = useState<KnowledgeJobsSummary>(EMPTY_SUMMARY);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshJobs = useCallback(async (options?: { quiet?: boolean }) => {
    const quiet = Boolean(options?.quiet);
    try {
      if (!quiet) setLoading(true);
      const response = await fetch(
        "/api/knowledge/v1/jobs?includeRecent=1&limit=50",
        { cache: "no-store" },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(
          typeof body.error === "string"
            ? body.error
            : "无法读取处理队列",
        );
        return null;
      }
      const nextJobs: KnowledgeJob[] = Array.isArray(body.jobs) ? body.jobs : [];
      const nextSummary: KnowledgeJobsSummary = {
        ...EMPTY_SUMMARY,
        ...(body.summary && typeof body.summary === "object"
          ? body.summary
          : {}),
      };
      // 以列表为准校正 active，避免 summary 与条目短暂不一致
      const activeFromList = nextJobs.filter((j) =>
        isActiveJobStatus(j.status),
      ).length;
      nextSummary.active = Math.max(
        Number(nextSummary.active) || 0,
        activeFromList,
      );
      setJobs(nextJobs);
      setSummary(nextSummary);
      setError("");
      return { jobs: nextJobs, summary: nextSummary };
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取处理队列");
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const hasActive = useCallback(
    (result: { jobs: KnowledgeJob[]; summary: KnowledgeJobsSummary }) =>
      (result.summary.active ?? 0) > 0 ||
      result.jobs.some((j) => isActiveJobStatus(j.status)),
    [],
  );

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void refreshJobs({ quiet: true }).then((result) => {
        if (!result) return;
        if (!hasActive(result)) stopPolling();
      });
    }, 1500);
  }, [refreshJobs, stopPolling, hasActive]);

  const openPanel = useCallback(() => {
    setOpen(true);
    void refreshJobs().then((result) => {
      if (result && hasActive(result)) startPolling();
      else stopPolling();
    });
  }, [refreshJobs, startPolling, stopPolling, hasActive]);

  const closePanel = useCallback(() => setOpen(false), []);

  const togglePanel = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        void refreshJobs().then((result) => {
          if (result && hasActive(result)) startPolling();
          else stopPolling();
        });
      }
      return next;
    });
  }, [refreshJobs, startPolling, stopPolling, hasActive]);

  /** 入队后：刷新角标；有任务时展开顶栏下拉并轮询 */
  const notifyJobsChanged = useCallback(() => {
    setOpen(true);
    void refreshJobs().then((result) => {
      if (result && hasActive(result)) startPolling();
      else stopPolling();
    });
  }, [refreshJobs, startPolling, stopPolling, hasActive]);

  useEffect(() => {
    void refreshJobs().then((result) => {
      if (!result) return;
      if (hasActive(result)) startPolling();
    });
    return () => stopPolling();
  }, [refreshJobs, startPolling, stopPolling, hasActive]);

  const { activeJobs, recentJobs } = useMemo(
    () => partitionKnowledgeJobs(jobs),
    [jobs],
  );

  const activeCount = Math.max(summary.active, activeJobs.length);

  return {
    jobs,
    activeJobs,
    recentJobs,
    summary,
    activeCount,
    open,
    loading,
    error,
    setOpen,
    openPanel,
    closePanel,
    togglePanel,
    refreshJobs,
    notifyJobsChanged,
    startPolling,
    stopPolling,
  };
}
