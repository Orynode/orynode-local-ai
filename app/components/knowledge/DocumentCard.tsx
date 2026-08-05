"use client";

import { useState } from "react";
import type { KnowledgeDocument } from "../../../services/types";
import type { KnowledgeDocumentViewStatus } from "../../../services/knowledge/status";
import { documentViewStatus } from "../../../services/knowledge/status";
import { Icon } from "../ui/Icon";

interface DocumentCardProps {
  document: KnowledgeDocument;
  selected: boolean;
  reindexing: boolean;
  /** 是否开启语义检索（决定徽章文案与「重建」按钮） */
  semanticEnabled: boolean;
  /** 可选：父级已算好的投影，避免列表重复计算 */
  viewStatus?: KnowledgeDocumentViewStatus;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
  onReprocess?: (id: string) => void;
  onRename: (id: string, name: string) => void | Promise<unknown>;
  onPreview?: (document: KnowledgeDocument) => void;
}

export function DocumentCard({
  document,
  selected,
  reindexing,
  semanticEnabled,
  viewStatus: viewStatusProp,
  onSelect,
  onDelete,
  onReindex,
  onReprocess,
  onRename,
  onPreview,
}: DocumentCardProps) {
  const status = document.status ?? "ready";
  const viewStatus =
    viewStatusProp ?? documentViewStatus(document, semanticEnabled);
  const canReprocess =
    Boolean(onReprocess) && viewStatus.canRetryProcessing;
  const canReindex =
    semanticEnabled &&
    viewStatus.content === "usable" &&
    !canReprocess &&
    (status === "ready" || status === "indexed" || status === "error");
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(document.name);
  const [saving, setSaving] = useState(false);

  async function commitRename() {
    const next = draftName.trim();
    if (!next || next === document.name) {
      setEditing(false);
      setDraftName(document.name);
      return;
    }
    setSaving(true);
    try {
      await onRename(document.id, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      className={[
        "knowledge-card",
        selected ? "selected" : "",
        `is-${viewStatus.severity}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        className={`knowledge-select ${viewStatus.canAttach ? "" : "is-unavailable"}`}
        aria-disabled={!viewStatus.canAttach}
        title={
          viewStatus.canAttach
            ? "选择用于对话"
            : "该文件尚无可检索文本，只能预览原件"
        }
        onClick={() => {
          if (!editing && viewStatus.canAttach) onSelect(document.id);
        }}
      >
        <span className="knowledge-file-icon">
          <Icon name="database" />
        </span>
        <span>
          {editing ? (
            <input
              className="knowledge-rename-input"
              value={draftName}
              disabled={saving}
              autoFocus
              aria-label="显示名称"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                }
                if (event.key === "Escape") {
                  setEditing(false);
                  setDraftName(document.name);
                }
              }}
              onBlur={() => {
                void commitRename();
              }}
            />
          ) : (
            <strong>{document.name}</strong>
          )}
          <span className="knowledge-status-row">
            <span
              className={`knowledge-status-badge is-${viewStatus.severity}`}
            >
              {viewStatus.label}
            </span>
          </span>
          <small>
            {document.pageCount} 页 ·{" "}
            {(document.size / 1024 / 1024).toFixed(1)} MB ·{" "}
            {document.chunkCount} 片段
            {document.originalName && document.originalName !== document.name
              ? ` · 原文件 ${document.originalName}`
              : ""}
          </small>
        </span>
      </button>
      <div className="knowledge-card-actions">
        <button
          className="knowledge-reindex"
          type="button"
          disabled={saving || editing}
          aria-label={`重命名：${document.name}`}
          title="修改显示名称（不影响内容去重）"
          onClick={() => {
            setDraftName(document.name);
            setEditing(true);
          }}
        >
          重命名
        </button>
        {canReprocess && (
          <button
            className="knowledge-reindex"
            type="button"
            disabled={reindexing}
            aria-label={`重试识别：${document.name}`}
            title="重新识别扫描页"
            onClick={() => onReprocess?.(document.id)}
          >
            重试
          </button>
        )}
        {onPreview ? (
          <button
            className="knowledge-reindex"
            type="button"
            aria-label={`预览：${document.name}`}
            title="预览原件"
            onClick={() => onPreview(document)}
          >
            预览
          </button>
        ) : null}
        {canReindex && (
          <button
            className="knowledge-reindex"
            type="button"
            disabled={reindexing}
            aria-label={`重建索引：${document.name}`}
            title="重建语义向量"
            onClick={() => onReindex(document.id)}
          >
            重建
          </button>
        )}
        <button
          className="knowledge-delete"
          aria-label={`删除资料：${document.name}`}
          onClick={() => onDelete(document.id)}
        >
          <Icon name="trash" />
        </button>
      </div>
      {viewStatus.severity === "danger" ||
      viewStatus.severity === "warning" ? (
        <div
          className={`knowledge-card-alert is-${viewStatus.severity}`}
          role="status"
        >
          <Icon name="alert" />
          <span>
            <strong>{viewStatus.label}</strong>
            <small>{viewStatus.detail}</small>
          </span>
        </div>
      ) : null}
    </article>
  );
}
