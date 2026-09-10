"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModalShell } from "../ui/ModalShell";
import { citationUrlTransform } from "../../lib/citation-markdown";
import { wikiCompileErrorLabel } from "../../hooks/useKnowledgeJobs";
import {
  lastSettleId,
  stripSettleMarkers,
} from "../../../services/knowledge/wiki/settle-markers";

export type WikiOutlineSection = {
  heading: string;
  excerpt: string;
  chunkId: string;
  pageNumber: number;
  startLine?: number;
  endLine?: number;
  sourceDocumentId?: string;
  sourceDocumentTitle?: string;
};

export type WikiOutlinePage = {
  id?: string;
  title: string;
  kind?: string;
  compiler: string;
  markdown: string;
  sections: WikiOutlineSection[];
  synthesisMarkdown?: string;
  synthesisCompiler?: string;
  notesMarkdown?: string;
  status?: string;
  userEdited?: boolean;
  knowledge?: {
    claims?: Array<{ id?: string; text?: string; status?: string }>;
  };
  sourceDocumentId?: string;
  namespace?: "library" | "conversation";
  updatedAt?: string;
};

export type WikiHistoryEntry = {
  id: string;
  revision: number;
  reason: string;
  createdAt: string;
  excerpt?: string;
};

export type WikiCompileRun = {
  id: string;
  status: string;
  errorCode?: string;
  createdAt?: string;
};

export type WikiPendingCandidate = {
  id: string;
  pageId: string;
  kind: string;
  status: string;
  text: string;
};

export type WikiRelatedPage = {
  id: string;
  title: string;
  rel: string;
  direction: "incoming" | "outgoing";
};

function notesForDisplay(text: string): string {
  return stripSettleMarkers(text).replace(/^## 对话沉淀\s*/, "");
}

const REL_LABELS: Record<string, string> = {
  cites: "引用",
  see_also: "参见",
  part_of: "属于",
  is_a: "是一种",
  depends_on: "依赖",
  causes: "导致",
  contrasts_with: "对比",
  related_to: "相关",
};

const REVISION_REASON_LABELS: Record<string, string> = {
  compile: "生成前",
  edit: "修改前",
  settle: "写入前",
  restore: "回滚前",
};

function formatWikiTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WikiOutlineDialog({
  page,
  loading,
  compiling,
  error,
  relatedPages = [],
  pendingCandidates = [],
  history = [],
  compileRuns = [],
  reviewing = false,
  restoring = false,
  open = true,
  onClose,
  onOpenSource,
  onBack,
  backTitle,
  onOpenRelated,
  onGenerateSynthesis,
  onSaveEdit,
  onUndoSettle,
  onReviewCandidate,
  onRestoreRevision,
}: {
  page: WikiOutlinePage | null;
  loading: boolean;
  compiling: boolean;
  error: string;
  relatedPages?: WikiRelatedPage[];
  pendingCandidates?: WikiPendingCandidate[];
  history?: WikiHistoryEntry[];
  compileRuns?: WikiCompileRun[];
  reviewing?: boolean;
  restoring?: boolean;
  /** 打开原件时先收起，避免 modal 盖住侧栏预览；关掉预览后再回来 */
  open?: boolean;
  onClose: () => void;
  onOpenSource: (section: WikiOutlineSection) => void;
  onBack?: () => void;
  backTitle?: string;
  onOpenRelated?: (related: WikiRelatedPage) => void;
  onGenerateSynthesis?: (options?: { force?: boolean; confirmForce?: boolean }) => void;
  onSaveEdit?: (patch: { synthesisMarkdown: string }) => Promise<void> | void;
  onUndoSettle?: (settleId: string) => void;
  onReviewCandidate?: (id: string, action: "accept" | "reject") => void;
  onRestoreRevision?: (revision: number) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const hasSynthesis = Boolean(page?.synthesisMarkdown?.trim());
  const isConcept = page?.kind === "concept";
  const stale = page?.status === "stale";
  const undoId = lastSettleId(page?.notesMarkdown || "");
  const lastRun = compileRuns[0];
  const reviewClaims =
    page?.knowledge?.claims?.filter(
      (claim) =>
        claim.status === "conflicted" || claim.status === "withdrawn",
    ) ?? [];

  useEffect(() => {
    setEditing(false);
    setEditError("");
    bodyRef.current?.scrollTo({ top: 0 });
  }, [page?.id]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      titleRef.current?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open, page?.id]);

  function startEdit() {
    setDraft(page?.synthesisMarkdown ?? "");
    setEditing(true);
    setEditError("");
  }

  async function saveEdit() {
    if (!onSaveEdit) return;
    setSaving(true);
    setEditError("");
    try {
      await onSaveEdit({ synthesisMarkdown: draft });
      setEditing(false);
    } catch (caught) {
      setEditError(
        caught instanceof Error ? caught.message : "无法保存百科修改",
      );
    } finally {
      setSaving(false);
    }
  }

  function generateSynthesis() {
    if (!onGenerateSynthesis || !page) return;
    if (
      page.userEdited &&
      !window.confirm(
        "这一页已由你手动编辑。重新生成会用模型正文替换当前正文，但仍可从历史版本恢复。确定继续吗？",
      )
    ) {
      return;
    }
    onGenerateSynthesis({
      force: hasSynthesis || Boolean(page.userEdited),
      confirmForce: Boolean(page.userEdited),
    });
  }

  return (
    <ModalShell open={open} onClose={onClose}>
      <div
        className="knowledge-wiki-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-outline-title"
        ref={bodyRef}
      >
        {onBack ? (
          <button
            type="button"
            className="knowledge-wiki-back"
            onClick={onBack}
            disabled={loading}
          >
            返回{backTitle ? `「${backTitle}」` : "上一页"}
          </button>
        ) : null}
        <h2 id="wiki-outline-title" ref={titleRef} tabIndex={-1}>
          {page?.title ?? "百科"}
        </h2>
        <p className="knowledge-wiki-note">
          {isConcept
            ? hasSynthesis
              ? "跨资料整理的百科页。点出处打开原件。"
              : "已从资料归入这一页。点「写这一页」才会用本机模型写正文。"
            : hasSynthesis
              ? "这篇资料的百科摘要。点出处打开原件。"
              : "这篇资料的目录。点「写这一页」会用本机模型根据目录和原文写带出处的正文。"}
        </p>
        {stale ? (
          <p className="knowledge-wiki-stale" role="status">
            资料已更新，正文可能过时。可以重新生成，或直接改这一页。
          </p>
        ) : null}
        {page?.userEdited ? (
          <p className="knowledge-meta-line">这一页已人手改过，默认不会被自动覆盖。</p>
        ) : null}
        {reviewClaims.length > 0 ? (
          <section className="knowledge-wiki-review" aria-label="待复核主张">
            <h3>待复核主张</h3>
            <ul>
              {reviewClaims.map((claim, index) => (
                <li key={claim.id || `${claim.status}-${index}`}>
                  <strong>
                    {claim.status === "conflicted" ? "证据冲突" : "来源已撤回"}
                  </strong>
                  <span>{claim.text || "未命名主张"}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {loading ? <p className="knowledge-meta-line">正在打开…</p> : null}
        {compiling ? (
          <p className="knowledge-meta-line">
            正在写这一页。写完后会自动刷新。
          </p>
        ) : null}
        {error || editError ? (
          <p className="knowledge-feedback is-error" role="alert">
            {editError || error}
          </p>
        ) : null}
        {lastRun?.status === "failed" ? (
          <p className="knowledge-feedback is-error" role="status">
            上次生成失败
            {lastRun.errorCode
              ? `（${wikiCompileErrorLabel(lastRun.errorCode)}）`
              : ""}。
            上一成功版本还在。
          </p>
        ) : null}
        {editing ? (
          <div className="knowledge-wiki-edit">
            <label htmlFor="wiki-synthesis-edit">编辑正文</label>
            <textarea
              id="wiki-synthesis-edit"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={10}
            />
          </div>
        ) : hasSynthesis && page?.synthesisMarkdown ? (
          <div className="knowledge-wiki-synthesis">
            <h3>{page.userEdited ? "正文（已编辑）" : "正文"}</h3>
            <div className="knowledge-wiki-markdown">
              <Markdown remarkPlugins={[remarkGfm]} urlTransform={citationUrlTransform}>
                {page.synthesisMarkdown}
              </Markdown>
            </div>
          </div>
        ) : null}
        {page?.notesMarkdown?.trim() ? (
          <div className="knowledge-wiki-synthesis">
            <h3>来自对话</h3>
            <div className="knowledge-wiki-markdown">
              <Markdown remarkPlugins={[remarkGfm]} urlTransform={citationUrlTransform}>
                {notesForDisplay(page.notesMarkdown)}
              </Markdown>
            </div>
            {onUndoSettle && undoId ? (
              <button
                type="button"
                className="knowledge-scope-btn"
                disabled={reviewing}
                onClick={() => onUndoSettle(undoId)}
              >
                撤销上次写入
              </button>
            ) : null}
          </div>
        ) : null}
        {pendingCandidates.length > 0 ? (
          <div className="knowledge-wiki-synthesis">
            <h3>待审核</h3>
            <ul className="knowledge-wiki-sections">
              {pendingCandidates.map((candidate) => (
                <li key={candidate.id}>
                  <p className="knowledge-wiki-note">
                    {candidate.text.slice(0, 160)}
                    {candidate.text.length > 160 ? "…" : ""}
                  </p>
                  {onReviewCandidate ? (
                    <div className="knowledge-wiki-actions">
                      <button
                        type="button"
                        className="knowledge-scope-btn"
                        disabled={reviewing}
                        onClick={() => onReviewCandidate(candidate.id, "accept")}
                      >
                        保留
                      </button>
                      <button
                        type="button"
                        className="knowledge-scope-btn"
                        disabled={reviewing}
                        onClick={() => onReviewCandidate(candidate.id, "reject")}
                      >
                        撤回
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {relatedPages.length > 0 ? (
          <div className="knowledge-wiki-links">
            <h3>相关页</h3>
            <p className="knowledge-wiki-note">
              这些页还出现在别的资料里。点开会换成那一篇百科，不是打开原件。
            </p>
            <ul aria-label="相关页">
              {relatedPages.map((related) => (
                <li key={`${related.direction}-${related.id}-${related.rel}`}>
                  <button
                    type="button"
                    className="knowledge-wiki-link"
                    disabled={loading || related.id === page?.id}
                    onClick={() => onOpenRelated?.(related)}
                  >
                    <span>打开「{related.title.trim()}」</span>
                    <small>{REL_LABELS[related.rel] || related.rel}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {history.length > 0 ? (
          <div className="knowledge-wiki-history">
            <h3>历史版本</h3>
            <ul>
              {history.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  <div>
                    <strong>
                      {REVISION_REASON_LABELS[entry.reason] || entry.reason}
                    </strong>
                    <small>
                      {formatWikiTime(entry.createdAt)}
                      {entry.excerpt ? ` · ${entry.excerpt}` : ""}
                    </small>
                  </div>
                  {onRestoreRevision ? (
                    <button
                      type="button"
                      className="knowledge-scope-btn"
                      disabled={reviewing || restoring || compiling || editing}
                      onClick={() => onRestoreRevision(entry.revision)}
                    >
                      回滚
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {page && page.sections.length > 0 ? (
          <div className="knowledge-wiki-sources">
            <h3>出处</h3>
            <ol className="knowledge-wiki-sections">
              {page.sections.map((section) => (
                <li key={`${section.chunkId}-${section.heading}-${section.sourceDocumentId ?? ""}`}>
                  <button
                    type="button"
                    className="knowledge-wiki-section"
                    onClick={() => onOpenSource(section)}
                  >
                    <strong>{section.heading}</strong>
                    <p>{section.excerpt}</p>
                    <small>
                      {section.sourceDocumentTitle
                        ? `《${section.sourceDocumentTitle}》 · `
                        : ""}
                      第 {section.pageNumber} 页
                      {section.startLine != null ? ` · 第 ${section.startLine} 行` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {page && page.sections.length === 0 && !loading && !hasSynthesis ? (
          <div className="knowledge-wiki-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{page.markdown}</Markdown>
          </div>
        ) : null}
        <div className="knowledge-import-actions">
          {onSaveEdit && page ? (
            editing ? (
              <button
                type="button"
                className="knowledge-scope-btn"
                disabled={saving}
                onClick={() => void saveEdit()}
              >
                {saving ? "正在保存…" : "保存"}
              </button>
            ) : (
              <button
                type="button"
                className="knowledge-scope-btn"
                disabled={compiling || loading}
                onClick={startEdit}
              >
                编辑
              </button>
            )
          ) : null}
          {onGenerateSynthesis && page && page.sections.length > 0 ? (
            <button
              type="button"
              className="knowledge-scope-btn"
              disabled={compiling || loading || editing}
              onClick={generateSynthesis}
            >
              {compiling
                ? "正在写入…"
                : hasSynthesis
                  ? "重新生成"
                  : "写这一页"}
            </button>
          ) : null}
          <button type="button" className="knowledge-scope-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
