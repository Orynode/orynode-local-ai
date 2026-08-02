"use client";

import { useRef, useState } from "react";
import type { KnowledgeDocument, MessageAttachment } from "../../../services/types";
import type { KnowledgeMeta } from "../../hooks/useKnowledge";
import {
  allDocumentsAttachment,
  attachmentFromDocument,
} from "../../lib/attachments";
import { Icon } from "../ui/Icon";
import { DocumentCard } from "./DocumentCard";

interface KnowledgeViewProps {
  documents: KnowledgeDocument[];
  meta: KnowledgeMeta | null;
  uploading: boolean;
  reindexing: boolean;
  notice?: string;
  error?: string;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
  onReindexAll: () => void;
  onRename: (id: string, name: string) => void | Promise<unknown>;
  /** 导入；displayName 可选，默认文件名；内容哈希去重与名字无关 */
  onImport: (file: File, options?: { displayName?: string }) => void;
  /** 将选中资料写入新对话的本轮草稿，并切到助手 */
  onAttachToChat: (attachments: MessageAttachment[]) => void;
}

/**
 * 资料库页的选中仅用于「去对话」打包草稿；始终新开对话，不粘到历史会话。
 */
export function KnowledgeView({
  documents,
  meta,
  uploading,
  reindexing,
  notice = "",
  error = "",
  onDelete,
  onReindex,
  onReindexAll,
  onRename,
  onImport,
  onAttachToChat,
}: KnowledgeViewProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [pickAll, setPickAll] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");

  const semanticOn = meta?.semanticSearchEnabled === true;
  const indexedCount = documents.filter((doc) => doc.status === "indexed").length;
  const feedback = error || notice;
  const hasSelection = pickAll || pickedIds.length > 0;

  const metaLine = (() => {
    if (documents.length === 0) {
      return semanticOn
        ? "语义检索已开启 · 相同内容只会保留一份"
        : "默认关键词检索 · 相同内容只会保留一份";
    }
    if (semanticOn) {
      return indexedCount === documents.length
        ? `关键词 + 语义 · ${indexedCount} 篇已索引`
        : `关键词 + 语义 · ${indexedCount}/${documents.length} 已索引`;
    }
    return `仅关键词 · ${documents.length} 篇可检索`;
  })();

  function togglePick(id: string) {
    setPickAll(false);
    setPickedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function goChat() {
    if (pickAll) {
      onAttachToChat([allDocumentsAttachment()]);
      return;
    }
    const attachments = documents
      .filter((doc) => pickedIds.includes(doc.id))
      .map(attachmentFromDocument);
    if (attachments.length === 0) return;
    onAttachToChat(attachments);
  }

  function openPicker() {
    fileInput.current?.click();
  }

  function onFileChosen(file: File) {
    setPendingFile(file);
    setDisplayName(file.name.replace(/\.[^.]+$/, "") || file.name);
  }

  function confirmImport() {
    if (!pendingFile || uploading) return;
    const name = displayName.trim();
    onImport(pendingFile, name ? { displayName: name } : undefined);
    setPendingFile(null);
    setDisplayName("");
  }

  function cancelImport() {
    setPendingFile(null);
    setDisplayName("");
  }

  return (
    <section className="knowledge-view">
      <div className="knowledge-header">
        <div>
          <span className="local-badge">LOCAL DOCS</span>
          <h1>本地资料库</h1>
          <p>
            按文件内容去重（与显示名无关）；点选后「去对话」会新开对话并写入本轮草稿，发送后不会自动带到下一轮。
          </p>
          <p className="knowledge-meta-line">{metaLine}</p>
        </div>
        <div className="knowledge-header-actions">
          {documents.length > 0 && (
            <>
              <button
                className={`knowledge-scope-btn ${pickAll ? "active" : ""}`}
                type="button"
                onClick={() => {
                  setPickAll(true);
                  setPickedIds([]);
                }}
              >
                全选资料
              </button>
              <button
                className="knowledge-scope-btn"
                type="button"
                disabled={!hasSelection}
                onClick={goChat}
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
            onClick={openPicker}
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
            if (file) onFileChosen(file);
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
          onClick={openPicker}
          disabled={uploading}
        >
          <span>
            <Icon name="database" />
          </span>
          <strong>导入第一份资料</strong>
          <small>支持 PDF、TXT、Markdown，单个文件最大 50 MB；相同内容不会重复入库</small>
        </button>
      ) : (
        <div className="knowledge-list">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              selected={pickAll || pickedIds.includes(doc.id)}
              reindexing={reindexing}
              showReindex={semanticOn}
              onSelect={togglePick}
              onDelete={onDelete}
              onReindex={onReindex}
              onRename={onRename}
            />
          ))}
        </div>
      )}

      {pendingFile ? (
        <div
          className="knowledge-import-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelImport();
          }}
        >
          <div
            className="knowledge-import-dialog"
            role="dialog"
            aria-labelledby="knowledge-import-title"
          >
            <h2 id="knowledge-import-title">导入到资料库</h2>
            <p className="knowledge-import-file">文件：{pendingFile.name}</p>
            <label className="knowledge-import-label">
              显示名称（可选）
              <input
                type="text"
                value={displayName}
                maxLength={180}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={pendingFile.name}
              />
            </label>
            <p className="knowledge-import-hint">
              去重按文件内容，与显示名称无关；导入后仍可重命名。
            </p>
            <div className="knowledge-import-actions">
              <button type="button" className="knowledge-scope-btn" onClick={cancelImport}>
                取消
              </button>
              <button
                type="button"
                className="knowledge-upload"
                disabled={uploading}
                onClick={confirmImport}
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
