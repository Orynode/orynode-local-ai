"use client";

import { useEffect, useRef } from "react";
import type { KnowledgeJob } from "../../hooks/useKnowledgeJobs";
import {
  formatJobProgress,
  isActiveJobStatus,
  jobStatusLabel,
  jobTypeLabel,
  partitionKnowledgeJobs,
} from "../../hooks/useKnowledgeJobs";
import { Icon } from "../ui/Icon";

type KnowledgeJobsToggleProps = {
  open: boolean;
  activeCount: number;
  onToggle: () => void;
};

/** 全局顶栏入口：角标 = 进行中任务数 */
export function KnowledgeJobsToggle({
  open,
  activeCount,
  onToggle,
}: KnowledgeJobsToggleProps) {
  return (
    <button
      type="button"
      className={`topbar-icon-btn knowledge-jobs-topbar-btn ${open ? "active" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={
        activeCount > 0
          ? `处理中心，${activeCount} 个进行中`
          : "处理中心"
      }
      title={
        activeCount > 0
          ? `处理中心 · ${activeCount} 个进行中`
          : "处理中心"
      }
    >
      <Icon name="refresh" />
      {activeCount > 0 ? (
        <span className="knowledge-jobs-badge" aria-hidden="true">
          {activeCount > 99 ? "99+" : activeCount}
        </span>
      ) : null}
    </button>
  );
}

type KnowledgeJobsPanelProps = {
  open: boolean;
  jobs: KnowledgeJob[];
  activeCount: number;
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function JobListItems({
  jobs,
  showLiveClock,
}: {
  jobs: KnowledgeJob[];
  showLiveClock: boolean;
}) {
  return (
    <ul className="knowledge-jobs-list">
      {jobs.map((job) => {
        const progressText = formatJobProgress(job.progress);
        const live = showLiveClock && isActiveJobStatus(job.status);
        return (
          <li
            key={job.id}
            className={`knowledge-jobs-item status-${job.status}`}
          >
            <div className="knowledge-jobs-item-main">
              <strong>{jobTypeLabel(job.type)}</strong>
              <span className="knowledge-jobs-status">
                {jobStatusLabel(job.status)}
              </span>
            </div>
            <div className="knowledge-jobs-item-meta">
              <span>
                {job.documentName || job.documentId || "（无关联文档）"}
              </span>
              {progressText ? (
                <span className="knowledge-jobs-progress">{progressText}</span>
              ) : null}
            </div>
            {job.error ? (
              <p className="knowledge-jobs-item-error">{job.error}</p>
            ) : null}
            <div className="knowledge-jobs-item-time">
              {live ? "进行中" : `完成于 ${formatTime(job.updatedAt)}`}
              {job.attempts > 1
                ? ` · 尝试 ${job.attempts}/${job.maxAttempts}`
                : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 顶栏下拉：处理队列详情 */
export function KnowledgeJobsPanel({
  open,
  jobs,
  activeCount,
  loading,
  error,
  onRefresh,
}: KnowledgeJobsPanelProps) {
  if (!open) return null;

  const { activeJobs, recentJobs } = partitionKnowledgeJobs(jobs);
  const idle = activeCount <= 0 && activeJobs.length === 0;

  return (
    <div
      className="knowledge-jobs-panel knowledge-jobs-popover"
      aria-label="处理队列详情"
      role="dialog"
    >
      <div className="knowledge-jobs-panel-head">
        <strong>处理队列</strong>
        <button
          type="button"
          className="knowledge-scope-btn"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error ? <p className="knowledge-jobs-error">{error}</p> : null}

      {idle ? (
        <p className="knowledge-jobs-idle" role="status">
          没有进行中的任务
          {recentJobs.length > 0 ? " · 下方为最近完成记录" : ""}
        </p>
      ) : (
        <p className="knowledge-jobs-busy" role="status">
          进行中 {Math.max(activeCount, activeJobs.length)} 项
        </p>
      )}

      {activeJobs.length > 0 ? (
        <section className="knowledge-jobs-section" aria-label="进行中">
          <h3 className="knowledge-jobs-section-title">进行中</h3>
          <JobListItems jobs={activeJobs} showLiveClock />
        </section>
      ) : null}

      {recentJobs.length > 0 ? (
        <section
          className="knowledge-jobs-section knowledge-jobs-section-recent"
          aria-label="最近完成"
        >
          <h3 className="knowledge-jobs-section-title">最近完成</h3>
          <JobListItems jobs={recentJobs} showLiveClock={false} />
        </section>
      ) : null}

      {jobs.length === 0 && !error ? (
        <p className="knowledge-jobs-empty">暂无任务记录</p>
      ) : null}
    </div>
  );
}

type KnowledgeJobsMenuProps = {
  open: boolean;
  jobs: KnowledgeJob[];
  activeCount: number;
  loading: boolean;
  error: string;
  onToggle: () => void;
  onClose: () => void;
  onRefresh: () => void;
};

/** 顶栏菜单：点击外侧 / Esc 关闭 */
export function KnowledgeJobsMenu({
  open,
  jobs,
  activeCount,
  loading,
  error,
  onToggle,
  onClose,
  onRefresh,
}: KnowledgeJobsMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="knowledge-jobs-topbar" ref={rootRef}>
      <KnowledgeJobsToggle
        open={open}
        activeCount={activeCount}
        onToggle={onToggle}
      />
      <KnowledgeJobsPanel
        open={open}
        jobs={jobs}
        activeCount={activeCount}
        loading={loading}
        error={error}
        onRefresh={onRefresh}
      />
    </div>
  );
}
