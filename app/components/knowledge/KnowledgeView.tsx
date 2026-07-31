"use client";

import { useRef } from "react";
import type { KnowledgeDocument } from "../../../services/types";
import type { KnowledgeMeta } from "../../hooks/useKnowledge";
import { Icon } from "../ui/Icon";
import { DocumentCard } from "./DocumentCard";

interface KnowledgeViewProps {
  documents: KnowledgeDocument[];
  meta: KnowledgeMeta | null;
  selectedIds: string[];
  useAllDocuments: boolean;
  uploading: boolean;
  reindexing: boolean;
  notice?: string;
  error?: string;
  onToggle: (id: string) => void;
  onUseAll: () => void;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
  onReindexAll: () => void;
  onFileSelect: (file: File) => void;
  onChatWithSelection: () => void;
}

export function KnowledgeView({
  documents,
  meta,
  selectedIds,
  useAllDocuments,
  uploading,
  reindexing,
  notice = "",
  error = "",
  onToggle,
  onUseAll,
  onDelete,
  onReindex,
  onReindexAll,
  onFileSelect,
  onChatWithSelection,
}: KnowledgeViewProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const semanticOn = meta?.semanticSearchEnabled === true;
  const indexedCount = documents.filter((doc) => doc.status === "indexed").length;
  const feedback = error || notice;
  const hasSelection = useAllDocuments || selectedIds.length > 0;

  const metaLine = (() => {
    if (documents.length === 0) {
      return semanticOn ? "语义检索已开启" : "默认关键词检索";
    }
    if (semanticOn) {
      return indexedCount === documents.length
        ? `关键词 + 语义 · ${indexedCount} 篇已索引`
        : `关键词 + 语义 · ${indexedCount}/${documents.length} 已索引`;
    }
    return `仅关键词 · ${documents.length} 篇可检索`;
  })();

  return (
    <section className="knowledge-view">
      <div className="knowledge-header">
        <div>
          <span className="local-badge">LOCAL DOCS</span>
          <h1>本地资料库</h1>
          <p>点选一篇或多篇，再「去对话」；也可在对话框里直接选。</p>
          <p className="knowledge-meta-line">{metaLine}</p>
        </div>
        <div className="knowledge-header-actions">
          {documents.length > 0 && (
            <>
              <button
                className={`knowledge-scope-btn ${useAllDocuments ? "active" : ""}`}
                type="button"
                onClick={onUseAll}
              >
                全选资料
              </button>
              <button
                className="knowledge-scope-btn"
                type="button"
                disabled={!hasSelection}
                onClick={onChatWithSelection}
              >
                去对话
              </button>
              {semanticOn && (
                <button
                  className="knowledge-scope-btn"
                  type="button"
                  disabled={reindexing}
                  onClick={onReindexAll}
                  title="按现有文本片段重建语义向量"
                >
                  {reindexing ? "索引中…" : "重建索引"}
                </button>
              )}
            </>
          )}
          <button
            className="knowledge-upload"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            <Icon name="plus" />
            {uploading ? "正在解析..." : "导入资料"}
          </button>
        </div>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept="application/pdf,.pdf,text/plain,.txt,text/markdown,.md,.markdown"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFileSelect(file);
            if (fileInput.current) fileInput.current.value = "";
          }}
        />
      </div>

      {feedback ? (
        <p
          className={`knowledge-feedback ${error ? "is-error" : ""}`}
          role="status"
        >
          {feedback}
        </p>
      ) : null}

      {documents.length === 0 ? (
        <button
          className="knowledge-empty"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
        >
          <span>
            <Icon name="database" />
          </span>
          <strong>导入第一份资料</strong>
          <small>支持 PDF、TXT、Markdown，单个文件最大 50 MB</small>
        </button>
      ) : (
        <div className="knowledge-list">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              selected={useAllDocuments || selectedIds.includes(doc.id)}
              reindexing={reindexing}
              showReindex={semanticOn}
              onSelect={onToggle}
              onDelete={onDelete}
              onReindex={onReindex}
            />
          ))}
        </div>
      )}
    </section>
  );
}
