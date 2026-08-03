"use client";

import { useState } from "react";
import type { KnowledgeDocument } from "../../../services/types";
import {
  processingErrorLabel,
  statusLabel,
} from "../../../services/knowledge/status";
import { Icon } from "../ui/Icon";

interface DocumentCardProps {
  document: KnowledgeDocument;
  selected: boolean;
  reindexing: boolean;
  showReindex: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
  onReprocess?: (id: string) => void;
  onRename: (id: string, name: string) => void | Promise<unknown>;
}

export function DocumentCard({
  document,
  selected,
  reindexing,
  showReindex,
  onSelect,
  onDelete,
  onReindex,
  onReprocess,
  onRename,
}: DocumentCardProps) {
  const status = document.status ?? "ready";
  const canReprocess =
    Boolean(onReprocess) && status === "processing_error";
  const canReindex =
    showReindex &&
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
    <article className={`knowledge-card ${selected ? "selected" : ""}`}>
      <button
        className="knowledge-select"
        onClick={() => {
          if (!editing) onSelect(document.id);
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
          <small>
            {document.pageCount} 页 ·{" "}
            {(document.size / 1024 / 1024).toFixed(1)} MB ·{" "}
            {document.chunkCount} 片段 · {statusLabel(status)}
            {status === "processing_error" && document.errorMessage
              ? `（${processingErrorLabel(document.errorMessage)}）`
              : document.errorMessage && status !== "processing"
                ? `（${document.errorMessage}）`
                : ""}
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
    </article>
  );
}
