"use client";

import { useMemo, useRef, useState } from "react";
import type { KnowledgeDocument, MessageAttachment } from "../../../services/types";
import type { RetrievalHit } from "../../../services/knowledge/types";
import type {
  KnowledgeMeta,
  KnowledgeUploadState,
} from "../../hooks/useKnowledge";
import {
  attachmentFromDocument,
} from "../../lib/attachments";
import {
  hasLexicalHighlight,
  highlightSearchSnippet,
} from "../../lib/highlight-search-terms";
import { MAX_KNOWLEDGE_FILE_SIZE_LABEL } from "../../../config/defaults";
import { useDocumentPreview } from "../../lib/document-preview";
import { Icon } from "../ui/Icon";
import { ModalShell } from "../ui/ModalShell";
import { DocumentCard } from "./DocumentCard";
import {
  summarizeDegradedReasons,
} from "../../../services/knowledge/retrieval/degraded-labels";
import { documentViewStatus } from "../../../services/knowledge/status";

const PAGE_SIZE = 12;
const SEARCH_PAGE_SIZE = 8;
const SEARCH_PREVIEW_LIMIT = 64;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface KnowledgeViewProps {
  documents: KnowledgeDocument[];
  meta: KnowledgeMeta | null;
  uploading: boolean;
  uploadState?: KnowledgeUploadState | null;
  reindexing: boolean;
  notice?: string;
  error?: string;
  onDelete: (id: string) => void;
  onReindex: (id: string) => void;
  onReprocess?: (id: string) => void;
  onReindexAll: () => void;
  onRename: (id: string, name: string) => void | Promise<unknown>;
  /**
   * 导入一或多个文件。单文件时可传 displayName；多文件一律用各自文件名。
   */
  onImport: (files: File[], options?: { displayName?: string }) => void;
  onImportWeb: (url: string) => void;
  onImportGitHub: (input: {
    owner: string;
    repo: string;
    ref?: string;
    pathPrefix?: string;
    token?: string;
  }) => void;
  /** 将选中资料写入新对话的本轮草稿，并切到助手 */
  onAttachToChat: (attachments: MessageAttachment[]) => void;
  /** 顶栏处理中心角标用的进行中任务数（页眉进度文案） */
  jobsActiveCount?: number;
}

/**
 * 资料库页的选中仅用于「去对话」打包草稿；始终新开对话，不粘到历史会话。
 */
export function KnowledgeView({
  documents,
  meta,
  uploading,
  uploadState = null,
  reindexing,
  notice = "",
  error = "",
  onDelete,
  onReindex,
  onReprocess,
  onReindexAll,
  onRename,
  onImport,
  onImportWeb,
  onImportGitHub,
  onAttachToChat,
  jobsActiveCount = 0,
}: KnowledgeViewProps) {
  const { openPreview } = useDocumentPreview();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [connectorMode, setConnectorMode] = useState<"web" | "github" | null>(
    null,
  );
  const [webUrl, setWebUrl] = useState("");
  const [ghOwner, setGhOwner] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghRef, setGhRef] = useState("HEAD");
  const [ghPrefix, setGhPrefix] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  /** 最近一次成功检索用的 query，高亮与输入框解耦，避免改字未重搜时错位 */
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [highlightTerms, setHighlightTerms] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchPage, setSearchPage] = useState(1);
  const [searchHits, setSearchHits] = useState<RetrievalHit[]>([]);
  const [searchDiag, setSearchDiag] = useState<string>("");

  const semanticOn = meta?.semanticSearchEnabled === true;
  const documentViews = useMemo(
    () =>
      documents.map((doc) => ({
        document: doc,
        view: documentViewStatus(doc, semanticOn),
      })),
    [documents, semanticOn],
  );
  const indexedCount = documents.filter((doc) => doc.status === "indexed").length;
  const searchableCount = documentViews.filter(
    ({ view }) => view.content === "usable",
  ).length;
  const unavailableCount = documentViews.filter(
    ({ view }) => view.content === "unavailable",
  ).length;
  const semanticFailedCount = documentViews.filter(
    ({ view }) => view.semantic === "failed",
  ).length;
  const usableDocuments = useMemo(
    () => documentViews.filter(({ view }) => view.canAttach).map(({ document }) => document),
    [documentViews],
  );
  const feedback = error || notice;
  const hasSelection = pickedIds.length > 0;
  const allUsableSelected =
    usableDocuments.length > 0 &&
    usableDocuments.every((doc) => pickedIds.includes(doc.id));
  const searchTotalPages = Math.max(
    1,
    Math.ceil(searchHits.length / SEARCH_PAGE_SIZE),
  );
  const safeSearchPage = Math.min(searchPage, searchTotalPages);
  const visibleSearchHits = useMemo(() => {
    const start = (safeSearchPage - 1) * SEARCH_PAGE_SIZE;
    return searchHits.slice(start, start + SEARCH_PAGE_SIZE);
  }, [safeSearchPage, searchHits]);

  const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageDocumentViews = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return documentViews.slice(start, start + PAGE_SIZE);
  }, [documentViews, safePage]);

  const metaLine = (() => {
    if (documents.length === 0) {
      return semanticOn
        ? "语义检索已开启 · 相同内容只会保留一份"
        : "默认关键词检索 · 相同内容只会保留一份";
    }
    // 页眉订阅 Job.active：有进行中任务时显示进度，空闲且全索引则「已就绪」
    if (jobsActiveCount > 0 || reindexing) {
      if (semanticOn) {
        const denom = searchableCount || documents.length;
        return `语义索引进行中 ${indexedCount}/${denom} · 期间仍可使用基础搜索`;
      }
      return `后台处理中 ${Math.max(jobsActiveCount, 1)} 项 · 资料仍可检索`;
    }
    if (semanticOn) {
      if (searchableCount > 0 && indexedCount >= searchableCount) {
        return `已就绪 · 关键词 + 语义 · ${indexedCount} 篇${
          unavailableCount > 0 ? ` · ${unavailableCount} 篇无法检索` : ""
        }`;
      }
      if (searchableCount > 0 && indexedCount < searchableCount) {
        return `关键词可用 · 语义 ${indexedCount}/${searchableCount} · 可点右上角查看队列`;
      }
      return `关键词 + 语义 · ${indexedCount} 篇已索引`;
    }
    return `仅关键词 · ${searchableCount} 篇可检索${
      unavailableCount > 0 ? ` · ${unavailableCount} 篇无法检索` : ""
    }`;
  })();

  function togglePick(id: string) {
    setPickedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function selectAllUsable() {
    setPickedIds(usableDocuments.map((doc) => doc.id));
  }

  function goChat() {
    const selected = new Set(pickedIds);
    const attachments = usableDocuments
      .filter((doc) => selected.has(doc.id))
      .map(attachmentFromDocument);
    if (attachments.length === 0) return;
    onAttachToChat(attachments);
  }

  function openPicker() {
    fileInput.current?.click();
  }

  function onFilesChosen(files: File[]) {
    if (files.length === 0) return;
    setPendingFiles(files);
    if (files.length === 1) {
      setDisplayName(files[0].name.replace(/\.[^.]+$/, "") || files[0].name);
    } else {
      setDisplayName("");
    }
  }

  function confirmImport() {
    if (pendingFiles.length === 0 || uploading) return;
    if (pendingFiles.length === 1) {
      const name = displayName.trim();
      onImport(pendingFiles, name ? { displayName: name } : undefined);
    } else {
      onImport(pendingFiles);
    }
    setPendingFiles([]);
    setDisplayName("");
  }

  function cancelImport() {
    setPendingFiles([]);
    setDisplayName("");
  }

  function goToPage(next: number) {
    setPage(Math.min(totalPages, Math.max(1, next)));
  }

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchDiag("");
    try {
      const response = await fetch("/api/knowledge/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: q,
          scope: { mode: "sources", library: "all" },
          // 工作台需要浏览结果集；Chat/RAG 仍使用默认 topK=8。
          topK: SEARCH_PREVIEW_LIMIT,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "检索失败");
      setActiveSearchQuery(q);
      setHighlightTerms(
        Array.isArray(body.highlightTerms) && body.highlightTerms.length > 0
          ? body.highlightTerms
          : [q],
      );
      setSearchHits(body.hits ?? []);
      setSearchPage(1);
      const d = body.diagnostics;
      const degradedCodes = [
        ...(Array.isArray(d?.degradedReasons) ? d.degradedReasons : []),
        ...(Array.isArray(d?.degradedCapabilities)
          ? d.degradedCapabilities
          : []),
      ];
      const degradedText = summarizeDegradedReasons(degradedCodes);
      setSearchDiag(
        d
          ? `策略 ${ (d.strategy ?? []).join("+") || "—" } · ${d.candidateCount ?? 0} 条 · ${d.elapsedMs ?? 0}ms` +
              (d.requestedTier &&
              d.effectiveTier &&
              d.requestedTier !== d.effectiveTier
                ? ` · ${d.requestedTier}→${d.effectiveTier}`
                : "") +
              (degradedText ? ` · ${degradedText}` : "") +
              (Array.isArray(body.hits) && body.hits.length === 0
                ? " · 无可靠命中"
                : "")
          : "",
      );
    } catch (e) {
      setSearchHits([]);
      setActiveSearchQuery("");
      setHighlightTerms([]);
      setSearchDiag(e instanceof Error ? e.message : "检索失败");
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchHits([]);
    setSearchDiag("");
    setActiveSearchQuery("");
    setHighlightTerms([]);
    setSearchPage(1);
  }

  const hasSearchResults = searchHits.length > 0 || Boolean(searchDiag);

  return (
    <section className="knowledge-view" aria-label="本地资料库">
      <div className="knowledge-view-inner">
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
                className={`knowledge-scope-btn ${allUsableSelected ? "active" : ""}`}
                type="button"
                disabled={usableDocuments.length === 0}
                onClick={selectAllUsable}
              >
                全部可检索资料
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
            {uploading
              ? uploadState?.batchTotal
                ? `导入中 ${uploadState.batchIndex}/${uploadState.batchTotal}`
                : "正在解析..."
              : "导入资料"}
          </button>
          <button
            className="knowledge-scope-btn"
            type="button"
            disabled={uploading}
            onClick={() => setConnectorMode("web")}
          >
            网页 URL
          </button>
          <button
            className="knowledge-scope-btn"
            type="button"
            disabled={uploading}
            onClick={() => setConnectorMode("github")}
          >
            GitHub
          </button>
        </div>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          multiple
          accept="application/pdf,.pdf,text/plain,.txt,text/markdown,.md,.markdown"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) onFilesChosen(files);
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

      {uploading && uploadState ? (
        <div className="knowledge-batch-progress" role="status">
          <div className="knowledge-batch-progress-bar">
            <span style={{ width: `${uploadState.percent}%` }} />
          </div>
          <p>
            {uploadState.batchTotal
              ? `${uploadState.batchIndex}/${uploadState.batchTotal} · `
              : null}
            <strong>{uploadState.fileName}</strong>
            {uploadState.phase === "uploading"
              ? ` · 上传 ${uploadState.percent}%`
              : " · 处理中…"}
          </p>
        </div>
      ) : null}

      {unavailableCount > 0 || semanticFailedCount > 0 ? (
        <div className="knowledge-library-alert" role="alert">
          <Icon name="alert" />
          <div>
            <strong>资料库中有需要处理的文件</strong>
            <p>
              {unavailableCount > 0
                ? `${unavailableCount} 篇没有可检索文本，只能预览原件`
                : null}
              {unavailableCount > 0 && semanticFailedCount > 0 ? "；" : null}
              {semanticFailedCount > 0
                ? `${semanticFailedCount} 篇语义索引失败，但仍可关键词检索`
                : null}
              。问题文件已在下方显眼标出。
            </p>
          </div>
        </div>
      ) : null}

      {documents.length > 0 ? (
        <div className="knowledge-search-bar">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runSearch();
              }
            }}
            placeholder="检索预览（与 Agent 同一 Search API；对话问答走 Retrieve）"
            aria-label="资料库检索预览"
          />
          <button
            type="button"
            className="knowledge-scope-btn"
            disabled={searching || !searchQuery.trim()}
            onClick={() => void runSearch()}
          >
            {searching ? "检索中…" : "检索"}
          </button>
          <button
            type="button"
            className="knowledge-scope-btn"
            disabled={searching || !hasSearchResults}
            onClick={clearSearch}
            aria-label="清空检索结果"
          >
            清空
          </button>
        </div>
      ) : null}

      {searchDiag ? (
        <p className="knowledge-meta-line" role="status">
          {searchDiag}
        </p>
      ) : null}

      {searchHits.length > 0 ? (
        <>
        <ul className="knowledge-search-hits">
          {visibleSearchHits.map((hit) => {
            const terms =
              highlightTerms.length > 0 ? highlightTerms : [activeSearchQuery];
            // displayName 只是来源标签，不是召回证据；字面命中只看正文。
            const lexical = hasLexicalHighlight(hit.content, terms);
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  className="knowledge-search-hit-open"
                  disabled={!hit.documentId}
                  title={hit.documentId ? "预览原文" : "缺少 documentId"}
                  onClick={() => {
                    if (!hit.documentId) return;
                    openPreview({
                      documentId: hit.documentId,
                      sourceType: "library",
                      title: hit.documentName,
                      page: hit.pageNumber || 1,
                      startOffset: hit.startOffset,
                      endOffset: hit.endOffset,
                      bbox: hit.bbox,
                    });
                  }}
                >
                  <strong>
                    {hit.documentName}
                    {hit.pageNumber ? ` · p.${hit.pageNumber}` : ""}
                  </strong>
                  <span className="knowledge-meta-line">
                    score {hit.score?.toFixed?.(3) ?? hit.score} · {hit.source} ·{" "}
                    {hit.id.slice(0, 8)}
                    {!lexical ? " · 语义命中" : ""}
                  </span>
                  <p>{highlightSearchSnippet(hit.content, terms, 280)}</p>
                </button>
              </li>
            );
          })}
        </ul>
        {searchHits.length > SEARCH_PAGE_SIZE ? (
          <nav className="knowledge-pagination" aria-label="检索结果分页">
            <p className="knowledge-pagination-meta">
              共 {searchHits.length}
              {searchHits.length === SEARCH_PREVIEW_LIMIT ? "+" : ""} 条 · 每页 {SEARCH_PAGE_SIZE} 条
            </p>
            <div className="knowledge-pagination-actions">
              <button
                type="button"
                disabled={safeSearchPage <= 1}
                onClick={() => setSearchPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </button>
              <span className="knowledge-pagination-page">
                {safeSearchPage} / {searchTotalPages}
              </span>
              <button
                type="button"
                disabled={safeSearchPage >= searchTotalPages}
                onClick={() =>
                  setSearchPage((current) =>
                    Math.min(searchTotalPages, current + 1),
                  )
                }
              >
                下一页
              </button>
            </div>
          </nav>
        ) : null}
        </>
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
          <small>
            支持一次选择多个 PDF、TXT、Markdown，单个文件最大{" "}
            {MAX_KNOWLEDGE_FILE_SIZE_LABEL}；相同内容不会重复入库
          </small>
        </button>
      ) : (
        <>
          <div className="knowledge-list">
            {pageDocumentViews.map(({ document: doc, view }) => (
              <DocumentCard
                key={doc.id}
                document={doc}
                selected={pickedIds.includes(doc.id)}
                reindexing={reindexing}
                semanticEnabled={semanticOn}
                viewStatus={view}
                onSelect={togglePick}
                onDelete={onDelete}
                onReindex={onReindex}
                onReprocess={onReprocess}
                onRename={onRename}
                onPreview={(document) => {
                  openPreview({
                    documentId: document.id,
                    sourceType: "library",
                    title: document.name,
                    page: 1,
                  });
                }}
              />
            ))}
          </div>
          {documents.length > PAGE_SIZE ? (
            <nav className="knowledge-pagination" aria-label="资料列表分页">
              <p className="knowledge-pagination-meta">
                共 {documents.length} 篇 · 每页 {PAGE_SIZE} 篇
              </p>
              <div className="knowledge-pagination-actions">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => goToPage(safePage - 1)}
                >
                  上一页
                </button>
                <span className="knowledge-pagination-page">
                  {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => goToPage(safePage + 1)}
                >
                  下一页
                </button>
              </div>
            </nav>
          ) : null}
        </>
      )}

      {pendingFiles.length > 0 ? (
        <ModalShell open onClose={cancelImport}>
          <div
            className="knowledge-import-dialog knowledge-import-dialog--batch"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-import-title"
          >
            <h2 id="knowledge-import-title">
              {pendingFiles.length === 1
                ? "导入到资料库"
                : `导入 ${pendingFiles.length} 个文件`}
            </h2>
            {pendingFiles.length === 1 ? (
              <>
                <p className="knowledge-import-file">
                  文件：{pendingFiles[0].name}
                </p>
                <label className="knowledge-import-label">
                  显示名称（可选）
                  <input
                    type="text"
                    value={displayName}
                    maxLength={180}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={pendingFiles[0].name}
                  />
                </label>
                <p className="knowledge-import-hint">
                  去重按文件内容，与显示名称无关；导入后仍可重命名。单文件上限{" "}
                  {MAX_KNOWLEDGE_FILE_SIZE_LABEL}。
                </p>
              </>
            ) : (
              <>
                <ul className="knowledge-import-file-list">
                  {pendingFiles.map((file) => (
                    <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                      <span className="knowledge-import-file-name">
                        {file.name}
                      </span>
                      <span className="knowledge-import-file-size">
                        {formatFileSize(file.size)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="knowledge-import-hint">
                  将按顺序入库，显示名默认用文件名（导入后可重命名）。相同内容只会保留一份；单文件上限{" "}
                  {MAX_KNOWLEDGE_FILE_SIZE_LABEL}。
                </p>
              </>
            )}
            <div className="knowledge-import-actions">
              <button
                type="button"
                className="knowledge-scope-btn"
                onClick={cancelImport}
              >
                取消
              </button>
              <button
                type="button"
                className="knowledge-upload"
                disabled={uploading}
                onClick={confirmImport}
              >
                {pendingFiles.length === 1
                  ? "确认导入"
                  : `确认导入 ${pendingFiles.length} 个`}
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {connectorMode ? (
        <ModalShell open onClose={() => setConnectorMode(null)}>
          <div
            className="knowledge-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connector-import-title"
          >
            <h2 id="connector-import-title">
              {connectorMode === "web" ? "导入网页" : "同步 GitHub 仓库"}
            </h2>
            {connectorMode === "web" ? (
              <label className="knowledge-import-label">
                网页 URL
                <input
                  type="url"
                  value={webUrl}
                  onChange={(event) => setWebUrl(event.target.value)}
                  placeholder="https://example.com/docs"
                />
              </label>
            ) : (
              <>
                <label className="knowledge-import-label">
                  Owner
                  <input
                    type="text"
                    value={ghOwner}
                    onChange={(event) => setGhOwner(event.target.value)}
                    placeholder="Orynode"
                  />
                </label>
                <label className="knowledge-import-label">
                  Repo
                  <input
                    type="text"
                    value={ghRepo}
                    onChange={(event) => setGhRepo(event.target.value)}
                    placeholder="orynode-local-ai"
                  />
                </label>
                <label className="knowledge-import-label">
                  Ref（分支/标签/commit）
                  <input
                    type="text"
                    value={ghRef}
                    onChange={(event) => setGhRef(event.target.value)}
                    placeholder="HEAD"
                  />
                </label>
                <label className="knowledge-import-label">
                  路径前缀（可选）
                  <input
                    type="text"
                    value={ghPrefix}
                    onChange={(event) => setGhPrefix(event.target.value)}
                    placeholder="docs"
                  />
                </label>
                <label className="knowledge-import-label">
                  Token（可选，不入库；也可设 ORYNODE_GITHUB_TOKEN）
                  <input
                    type="password"
                    value={ghToken}
                    onChange={(event) => setGhToken(event.target.value)}
                    placeholder="ghp_…"
                    autoComplete="off"
                  />
                </label>
              </>
            )}
            <p className="knowledge-import-hint">
              {connectorMode === "web"
                ? "仅抓取正文，禁止脚本；私网/本地地址会被拒绝。"
                : "文本文件进入统一资料管线；远端删除会标记 tombstone，默认不删本地文档。"}
            </p>
            <div className="knowledge-import-actions">
              <button
                type="button"
                className="knowledge-scope-btn"
                onClick={() => setConnectorMode(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="knowledge-upload"
                disabled={uploading}
                onClick={() => {
                  if (connectorMode === "web") {
                    if (!webUrl.trim()) return;
                    onImportWeb(webUrl.trim());
                    setConnectorMode(null);
                    setWebUrl("");
                    return;
                  }
                  if (!ghOwner.trim() || !ghRepo.trim()) return;
                  onImportGitHub({
                    owner: ghOwner.trim(),
                    repo: ghRepo.trim(),
                    ref: ghRef.trim() || "HEAD",
                    pathPrefix: ghPrefix.trim() || undefined,
                    token: ghToken.trim() || undefined,
                  });
                  setConnectorMode(null);
                  setGhToken("");
                }}
              >
                开始同步
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}
      </div>
    </section>
  );
}
