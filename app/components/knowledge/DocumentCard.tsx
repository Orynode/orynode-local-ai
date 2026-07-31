"use client";

import type { KnowledgeDocument } from "../../../services/types";
import { statusLabel } from "../../../services/knowledge/status";
import { Icon } from "../ui/Icon";

interface DocumentCardProps {
  document: KnowledgeDocument;
  selected: boolean;
  reindexing: boolean;
  showReindex: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
}

export function DocumentCard({
  document,
  selected,
  reindexing,
  showReindex,
  onSelect,
  onDelete,
  onReindex,
}: DocumentCardProps) {
  const status = document.status ?? "ready";
  const canReindex =
    showReindex &&
    (status === "ready" || status === "indexed" || status === "error");

  return (
    <article className={`knowledge-card ${selected ? "selected" : ""}`}>
      <button
        className="knowledge-select"
        onClick={() => onSelect(document.id)}
      >
        <span className="knowledge-file-icon">
          <Icon name="database" />
        </span>
        <span>
          <strong>{document.name}</strong>
          <small>
            {document.pageCount} 页 ·{" "}
            {(document.size / 1024 / 1024).toFixed(1)} MB ·{" "}
            {document.chunkCount} 片段 · {statusLabel(status)}
            {document.errorMessage ? `（${document.errorMessage}）` : ""}
          </small>
        </span>
      </button>
      <div className="knowledge-card-actions">
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
