"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import type { KnowledgeJob } from "../../hooks/useKnowledgeJobs";
import {
  formatJobProgress,
  isActiveJobStatus,
  jobStatusLabel,
  jobTypeLabel,
  wikiCompileErrorLabel,
  partitionKnowledgeJobs,
  type KnowledgeJobsPanelTab,
} from "../../hooks/useKnowledgeJobs";
import { Icon } from "../ui/Icon";

function subscribeClient() {
  return () => undefined;
}

function isClientSnapshot() {
  return true;
}

function isServerSnapshot() {
  return false;
}

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
  tab: KnowledgeJobsPanelTab;
  onTabChange: (tab: KnowledgeJobsPanelTab) => void;
  onRefresh: () => void;
  onRetry?: (jobId: string) => void;
  panelRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
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
  onRetry,
}: {
  jobs: KnowledgeJob[];
  showLiveClock: boolean;
  onRetry?: (jobId: string) => void;
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
              <p className="knowledge-jobs-item-error">
                {wikiCompileErrorLabel(job.error)}
              </p>
            ) : null}
            {job.status === "failed" && onRetry ? (
              <button
                type="button"
                className="knowledge-scope-btn"
                onClick={() => onRetry(job.id)}
              >
                重新排队
              </button>
            ) : null}
            {live ? (
              job.attempts > 1 ? (
                <div className="knowledge-jobs-item-time">
                  尝试 {job.attempts}/{job.maxAttempts}
                </div>
              ) : null
            ) : (
              <div className="knowledge-jobs-item-time">
                {`完成于 ${formatTime(job.updatedAt)}`}
                {job.attempts > 1
                  ? ` · 尝试 ${job.attempts}/${job.maxAttempts}`
                  : null}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function KnowledgeJobsPanel({
  open,
  jobs,
  activeCount,
  loading,
  error,
  tab,
  onTabChange,
  onRefresh,
  onRetry,
  panelRef,
  style,
}: KnowledgeJobsPanelProps) {
  const { activeJobs, recentJobs } = partitionKnowledgeJobs(jobs);
  const visibleJobs = tab === "active" ? activeJobs : recentJobs;
  const activeLabelCount = Math.max(activeCount, activeJobs.length);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="knowledge-jobs-panel knowledge-jobs-popover"
      style={style}
      aria-label="处理队列详情"
      role="dialog"
      aria-modal="false"
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

      <div className="knowledge-jobs-tabs" role="tablist" aria-label="任务分组">
        <button
          type="button"
          role="tab"
          id="knowledge-jobs-tab-active"
          aria-selected={tab === "active"}
          aria-controls="knowledge-jobs-panel-body"
          className={
            tab === "active"
              ? "knowledge-jobs-tab knowledge-jobs-tab-active"
              : "knowledge-jobs-tab"
          }
          onClick={() => onTabChange("active")}
        >
          进行中
          <span className="knowledge-jobs-tab-count">{activeLabelCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="knowledge-jobs-tab-recent"
          aria-selected={tab === "recent"}
          aria-controls="knowledge-jobs-panel-body"
          className={
            tab === "recent"
              ? "knowledge-jobs-tab knowledge-jobs-tab-active"
              : "knowledge-jobs-tab"
          }
          onClick={() => onTabChange("recent")}
        >
          最近完成
          <span className="knowledge-jobs-tab-count">{recentJobs.length}</span>
        </button>
      </div>

      <div
        className={
          tab === "recent"
            ? "knowledge-jobs-body knowledge-jobs-body-recent"
            : "knowledge-jobs-body"
        }
        id="knowledge-jobs-panel-body"
        role="tabpanel"
        aria-labelledby={
          tab === "active"
            ? "knowledge-jobs-tab-active"
            : "knowledge-jobs-tab-recent"
        }
      >
        {visibleJobs.length > 0 ? (
          <JobListItems
            jobs={visibleJobs}
            showLiveClock={tab === "active"}
            onRetry={onRetry}
          />
        ) : error ? null : (
          <p className="knowledge-jobs-empty">
            {jobs.length === 0
              ? "暂无任务记录"
              : tab === "active"
                ? "没有进行中的任务"
                : "暂无完成记录"}
          </p>
        )}
      </div>
    </div>
  );
}

type KnowledgeJobsMenuProps = {
  open: boolean;
  jobs: KnowledgeJob[];
  activeCount: number;
  loading: boolean;
  error: string;
  tab: KnowledgeJobsPanelTab;
  onTabChange: (tab: KnowledgeJobsPanelTab) => void;
  onToggle: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onRetry?: (jobId: string) => void;
};

/** 顶栏菜单：Portal 到 overlay-root，避免被大纲等 modal 挡住 */
export function KnowledgeJobsMenu({
  open,
  jobs,
  activeCount,
  loading,
  error,
  tab,
  onTabChange,
  onToggle,
  onClose,
  onRefresh,
  onRetry,
}: KnowledgeJobsMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const isClient = useSyncExternalStore(
    subscribeClient,
    isClientSnapshot,
    isServerSnapshot,
  );

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    function place() {
      const anchor = rootRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPanelPos({
        top: Math.round(rect.bottom + 8),
        right: Math.round(window.innerWidth - rect.right),
      });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  const panel =
    open && isClient && panelPos
      ? createPortal(
          <KnowledgeJobsPanel
            open
            jobs={jobs}
            activeCount={activeCount}
            loading={loading}
            error={error}
            tab={tab}
            onTabChange={onTabChange}
            onRefresh={onRefresh}
            onRetry={onRetry}
            panelRef={panelRef}
            style={{ top: panelPos.top, right: panelPos.right }}
          />,
          document.getElementById("overlay-root") ?? document.body,
        )
      : null;

  return (
    <div className="knowledge-jobs-topbar" ref={rootRef}>
      <KnowledgeJobsToggle
        open={open}
        activeCount={activeCount}
        onToggle={onToggle}
      />
      {panel}
    </div>
  );
}
