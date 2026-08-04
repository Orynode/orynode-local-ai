"use client";

import { useEffect, useRef, useState } from "react";
import type {
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  Message,
  MessageAttachment,
} from "../services/types";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import { WelcomeScreen } from "./components/chat/WelcomeScreen";
import { Composer } from "./components/chat/Composer";
import { KnowledgeView } from "./components/knowledge/KnowledgeView";
import { DocumentPreviewShell } from "./components/preview/DocumentPreviewShell";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { useConversationFiles } from "./hooks/useConversationFiles";
import { useKnowledge } from "./hooks/useKnowledge";
import { useSettings } from "./hooks/useSettings";
import { Icon } from "./components/ui/Icon";
import { AlertDialog } from "./components/ui/AlertDialog";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { DocumentPreviewProvider } from "./lib/document-preview";
import { GITHUB_REPO_URL } from "../config/defaults";
import {
  readStoredDisplayName,
} from "./lib/displayName";
import { attachmentFromConversationFile } from "./lib/attachments";

type PendingDelete =
  | { type: "conversation"; id: string }
  | { type: "knowledge"; id: string }
  | null;

const PENDING_INDEX_STATUSES = new Set<KnowledgeDocumentStatus>([
  "processing",
  "stored",
  "awaiting_chunks",
]);

const FAILED_INDEX_STATUSES = new Set<KnowledgeDocumentStatus>([
  "processing_error",
  "error",
]);

function attachmentReadinessError(
  attachments: MessageAttachment[],
  conversationFiles: Array<{ id: string; name: string; status?: KnowledgeDocumentStatus }>,
  documents: Array<{ id: string; name: string; status?: KnowledgeDocumentStatus }>,
): string | null {
  const readyOrIndexing = new Set<KnowledgeDocumentStatus>([
    "ready",
    "embedding",
    "indexed",
  ]);

  for (const item of attachments) {
    if (item.kind === "conversation_file") {
      const file = conversationFiles.find((entry) => entry.id === item.id);
      if (!file) {
        return `「${item.name}」尚未同步到本对话附件列表，请稍后再发送`;
      }
      const status = file.status;
      if (!status) {
        return `「${file.name}」状态未知，请稍后再发送或刷新后重试`;
      }
      if (PENDING_INDEX_STATUSES.has(status)) {
        return `「${file.name}」仍在识别中，请稍后再发送`;
      }
      if (FAILED_INDEX_STATUSES.has(status)) {
        return `「${file.name}」识别失败，请删除或重建后再试`;
      }
      if (!readyOrIndexing.has(status)) {
        return `「${file.name}」尚未可检索（${status}），请稍后再发送`;
      }
    }
    if (item.kind === "library") {
      const doc = documents.find((entry) => entry.id === item.id);
      if (!doc) {
        return `「${item.name}」不在资料库列表中，请刷新后再挂载`;
      }
      const status = doc.status;
      if (!status) {
        return `「${doc.name}」状态未知，请稍后再发送或刷新后重试`;
      }
      if (PENDING_INDEX_STATUSES.has(status)) {
        return `「${doc.name}」仍在处理中，请稍后再发送`;
      }
      if (FAILED_INDEX_STATUSES.has(status)) {
        return `「${doc.name}」处理失败，请到资料库重试后再挂载`;
      }
      if (!readyOrIndexing.has(status)) {
        return `「${doc.name}」尚未可检索（${status}），请稍后再发送`;
      }
    }
    if (item.kind === "library_all") {
      const pending = documents.find(
        (doc) => doc.status && PENDING_INDEX_STATUSES.has(doc.status),
      );
      if (pending) {
        return `资料库中「${pending.name}」仍在处理中；全部资料检索可能不完整，请稍后再发送或取消「全部资料」`;
      }
      const failed = documents.find(
        (doc) => doc.status && FAILED_INDEX_STATUSES.has(doc.status),
      );
      if (failed) {
        return `资料库中「${failed.name}」处理失败；请先处理失败文档或取消「全部资料」后再发送`;
      }
    }
  }
  return null;
}

export default function Home() {
  // ---- State ----
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [viewMode, setViewMode] = useState<"assistant" | "knowledge">("assistant");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(readStoredDisplayName);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  /** 内容去重命中时弹窗（对话页也可见） */
  const [duplicateNotice, setDuplicateNotice] =
    useState<KnowledgeDocument | null>(null);
  /** 仅作用于下次发送；成功发送后清空，打开历史/新对话/删除当前会话不保留 */
  const [draftAttachments, setDraftAttachments] = useState<MessageAttachment[]>(
    [],
  );
  /** 取消进行中的会话附件上传，避免 New Chat 后脏写 draft */
  const attachGenerationRef = useRef(0);

  // ---- Hooks ----
  const chat = useChat();
  const conversations = useConversations();
  const knowledge = useKnowledge();
  const conversationFiles = useConversationFiles();
  const settingsHook = useSettings();

  // ---- Init ----
  useEffect(() => {
    const t = setTimeout(() => {
      void chat.checkStatus();
      void conversations.refresh();
      void knowledge.refresh();
      void settingsHook.load();
    }, 0);
    const interval = setInterval(() => { void chat.checkStatus(); }, 15000);
    return () => { clearTimeout(t); clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Save conversation helper ----
  async function saveConversation(
    messages: Message[],
    title: string,
    id: string | null,
  ): Promise<{ id: string; title: string }> {
    const response = await fetch(
      id ? `/api/conversations/${encodeURIComponent(id)}` : "/api/conversations",
      {
        method: id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, messages }),
      },
    );
    if (!response.ok) throw new Error("保存失败");
    const result = await response.json();
    return result.conversation;
  }

  // ---- Actions ----
  async function handleSubmit(hot?: {
    temperature: number;
    topP: number;
    topK: number;
    maxTokens: number;
  }) {
    const content = input.trim();
    if (!content || chat.sending) return;

    if (draftAttachments.length > 0) {
      const readiness = attachmentReadinessError(
        draftAttachments,
        conversationFiles.files,
        knowledge.documents,
      );
      if (readiness) {
        chat.setError(readiness);
        return;
      }
    }

    setInput("");

    const sampling = hot ?? {
      temperature: settingsHook.settings.temperature,
      topP: settingsHook.settings.topP,
      topK: settingsHook.settings.topK,
      maxTokens: settingsHook.settings.maxTokens,
    };

    const attachments =
      draftAttachments.length > 0 ? [...draftAttachments] : undefined;
    setDraftAttachments([]);

    const result = await chat.sendMessage(
      content,
      conversationId,
      conversationTitle,
      attachments,
      sampling.temperature,
      sampling.topP,
      sampling.topK,
      sampling.maxTokens,
      settingsHook.settings.maxContext,
      saveConversation,
    );

    if (result) {
      setConversationId(result.id);
      setConversationTitle(result.title);
      void conversations.refresh();
    } else {
      setInput(content);
      if (attachments) setDraftAttachments(attachments);
    }
  }

  async function handleOpenConversation(id: string) {
    try {
      attachGenerationRef.current += 1;
      conversationFiles.abortUpload();
      conversationFiles.clear();
      chat.discardActiveRun();
      const conv = await conversations.load(id);
      setConversationId(conv.id);
      setConversationTitle(conv.title);
      chat.setMessages(conv.messages ?? []);
      setDraftAttachments([]);
      await conversationFiles.refresh(conv.id);
      setViewMode("assistant");
    } catch {
      chat.setError("无法读取本地对话");
    }
  }

  async function handleDeleteConversation(id: string) {
    setPendingDelete({ type: "conversation", id });
  }

  async function handleDeleteKnowledge(id: string) {
    setPendingDelete({ type: "knowledge", id });
  }

  async function confirmPendingDelete() {
    if (!pendingDelete) return;
    const current = pendingDelete;
    setPendingDelete(null);

    if (current.type === "conversation") {
      try {
        await conversations.remove(current.id);
        if (conversationId === current.id) {
          attachGenerationRef.current += 1;
          conversationFiles.abortUpload();
          setConversationId(null);
          setConversationTitle("");
          chat.clearChat();
          setDraftAttachments([]);
          conversationFiles.clear();
        }
        await conversations.refresh();
      } catch {
        chat.setError("删除失败");
      }
      return;
    }

    const removed = await knowledge.remove(current.id);
    if (!removed) return;
    setDraftAttachments((prev) =>
      prev.filter(
        (item) =>
          item.kind === "library_all" ||
          item.kind === "conversation_file" ||
          item.id !== current.id,
      ),
    );
    if (conversationId) {
      void conversationFiles.refresh(conversationId);
    }
  }

  /** 导入资料库：不自动挂草稿；内容去重，显示名可选 */
  async function handleUploadKnowledge(
    file: File,
    options?: { displayName?: string },
  ) {
    const result = await knowledge.upload(file, options);
    if (result?.deduplicated) {
      setDuplicateNotice(result.document);
    }
  }

  async function ensureConversationId(): Promise<{
    id: string;
    created: boolean;
  }> {
    if (conversationId) return { id: conversationId, created: false };
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新对话", messages: [] }),
    });
    if (!response.ok) {
      throw new Error("无法创建对话以挂载附件");
    }
    const result = await response.json();
    const id = result.conversation.id as string;
    setConversationId(id);
    setConversationTitle(result.conversation.title || "新对话");
    void conversations.refresh();
    return { id, created: true };
  }

  /** 附到本对话：会话附件命名空间 */
  async function handleAttachConversationFile(file: File) {
    const generation = ++attachGenerationRef.current;
    let createdId: string | null = null;

    const discardCreatedConversation = () => {
      if (!createdId) return;
      const id = createdId;
      createdId = null;
      void conversations
        .remove(id)
        .then(() => conversations.refresh())
        .catch(() => undefined);
    };

    try {
      const ensured = await ensureConversationId();
      if (ensured.created) createdId = ensured.id;
      if (generation !== attachGenerationRef.current) {
        discardCreatedConversation();
        return;
      }
      const uploaded = await conversationFiles.upload(ensured.id, file);
      if (generation !== attachGenerationRef.current) {
        if (!uploaded) discardCreatedConversation();
        return;
      }
      if (!uploaded) return;
      createdId = null;
      setDraftAttachments((prev) => {
        if (
          prev.some(
            (item) =>
              item.kind === "conversation_file" && item.id === uploaded.file.id,
          )
        ) {
          return prev;
        }
        return [...prev, attachmentFromConversationFile(uploaded.file)];
      });
    } catch (e) {
      if (generation !== attachGenerationRef.current) {
        discardCreatedConversation();
        return;
      }
      conversationFiles.setError(
        e instanceof Error ? e.message : "无法附到本对话",
      );
    }
  }

  function handleNewChat() {
    const previousId = conversationId;
    const hadMessages = chat.messages.length > 0;
    const fileCount = conversationFiles.files.length;
    const wasUploading = conversationFiles.uploading;
    const draftHasConversationFile = draftAttachments.some(
      (item) => item.kind === "conversation_file",
    );
    attachGenerationRef.current += 1;
    conversationFiles.abortUpload();
    conversationFiles.clear();
    setConversationId(null);
    setConversationTitle("");
    chat.clearChat();
    setDraftAttachments([]);
    setViewMode("assistant");
    // 仅清理真正空壳；列表为空但草稿仍挂会话附件时不删，避免 refresh 失败误删
    if (
      previousId &&
      !hadMessages &&
      fileCount === 0 &&
      !wasUploading &&
      !draftHasConversationFile
    ) {
      void conversations
        .remove(previousId)
        .then(() => conversations.refresh())
        .catch(() => undefined);
    }
  }

  /** 资料库「去对话」：始终新开空对话，再挂上本轮资料库草稿 */
  function handleAttachToChat(attachments: MessageAttachment[]) {
    attachGenerationRef.current += 1;
    conversationFiles.abortUpload();
    conversationFiles.clear();
    setConversationId(null);
    setConversationTitle("");
    chat.clearChat();
    setDraftAttachments(
      attachments.filter((item) => item.kind !== "conversation_file"),
    );
    setViewMode("assistant");
  }

  async function handleRemoveConversationFile(fileId: string) {
    if (!conversationId) return;
    const ok = await conversationFiles.remove(conversationId, fileId);
    if (ok) {
      setDraftAttachments((prev) =>
        prev.filter(
          (item) =>
            !(item.kind === "conversation_file" && item.id === fileId),
        ),
      );
    }
  }

  async function handleReindexConversationFile(fileId: string) {
    if (!conversationId) return;
    await conversationFiles.reindex(conversationId, fileId);
  }

  function handleCopy(message: Message, format: "txt" | "md") {
    if (!message.content.trim()) return;
    try {
      let text = message.content;
      if (format === "txt") {
        const rendered = document.querySelector(
          `[data-message-id="${message.id}"] .message-markdown`,
        ) as HTMLElement | null;
        text = rendered?.innerText?.replace(/\n{3,}/g, "\n\n").trim() || message.content;
      }
      void navigator.clipboard.writeText(text);
      setCopiedMessageId(`${message.id}:${format}`);
      setTimeout(() => {
        setCopiedMessageId((c) => (c === `${message.id}:${format}` ? null : c));
      }, 1600);
    } catch {
      chat.setError("复制失败，请检查浏览器剪贴板权限");
    }
  }

  // ---- Render ----
  return (
    <DocumentPreviewProvider>
    <main className="app-shell">
      <Sidebar
        knowledgeCount={knowledge.documents.length}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onNewChat={handleNewChat}
        history={conversations.history}
        currentConversationId={conversationId}
        historyAvailable={conversations.available}
        onOpenConversation={(id) => { void handleOpenConversation(id); }}
        onDeleteConversation={(id) => { void handleDeleteConversation(id); }}
        displayName={displayName}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-main">
            <span className="eyebrow">当前模型</span>
            <strong className="model-status-line">
              <span
                className={`model-status-dot ${
                  chat.connected === true
                    ? "online"
                    : chat.connected === false
                      ? "offline"
                      : "checking"
                }`}
                aria-hidden="true"
              />
              <span>
                {chat.modelName}
                {viewMode === "assistant" && conversationTitle
                  ? ` · ${conversationTitle}`
                  : viewMode === "knowledge"
                    ? " · 本地资料库"
                    : ""}
              </span>
            </strong>
          </div>
          <div className="topbar-actions">
            <div
              className="topbar-status"
              title="对话由本机模型处理，不发送到 Orynode 服务器"
            >
              <span
                className={`model-status-dot ${
                  chat.connected === true
                    ? "online"
                    : chat.connected === false
                      ? "offline"
                      : "checking"
                }`}
                aria-hidden="true"
              />
              <span>
                本地
                {chat.connected === true
                  ? " · TurboFieldfare 已连接"
                  : chat.connected === false
                    ? " · TurboFieldfare 未启动"
                    : " · 正在检查模型"}
              </span>
            </div>
            <a
              className="topbar-icon-btn"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub 源码"
              title="GitHub 源码"
            >
              <Icon name="github" />
            </a>
            <button
              className="topbar-icon-btn"
              type="button"
              aria-label="设置"
              title="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" />
            </button>
          </div>
        </header>

        {viewMode === "knowledge" ? (
          <KnowledgeView
            documents={knowledge.documents}
            meta={knowledge.meta}
            uploading={knowledge.uploading}
            reindexing={knowledge.reindexing}
            notice={knowledge.notice}
            error={knowledge.error}
            onDelete={(id) => { void handleDeleteKnowledge(id); }}
            onReindex={(id) => { void knowledge.reindex(id); }}
            onReprocess={(id) => { void knowledge.reprocess(id); }}
            onReindexAll={() => { void knowledge.reindexAll(); }}
            onRename={(id, name) => knowledge.rename(id, name)}
            onImport={(file, options) => {
              void handleUploadKnowledge(file, options);
            }}
            onImportWeb={(url) => {
              void knowledge.importWeb(url);
            }}
            onImportGitHub={(input) => {
              void knowledge.importGitHub(input);
            }}
            onAttachToChat={handleAttachToChat}
          />
        ) : chat.messages.length === 0 ? (
          <>
            <WelcomeScreen
              connected={chat.connected}
              onSuggestionClick={(text) => setInput(text)}
            />
            {chat.error && <div className="error-banner">{chat.error}</div>}
            {(knowledge.error ||
              conversationFiles.error ||
              settingsHook.error ||
              conversationFiles.notice) && (
              <div
                className={
                  knowledge.error || conversationFiles.error || settingsHook.error
                    ? "error-banner"
                    : "notice-banner"
                }
              >
                {knowledge.error ||
                  conversationFiles.error ||
                  settingsHook.error ||
                  conversationFiles.notice}
              </div>
            )}
            <Composer
              input={input}
              onInputChange={setInput}
              onSubmit={(hot) => { void handleSubmit(hot); }}
              sending={chat.sending}
              onStop={chat.stopGeneration}
              documents={knowledge.documents}
              conversationFiles={conversationFiles.files}
              draftAttachments={draftAttachments}
              onDraftAttachmentsChange={setDraftAttachments}
              uploading={
                knowledge.uploading || conversationFiles.uploading
              }
              uploadState={
                conversationFiles.uploadState ?? knowledge.uploadState
              }
              onAttachFileSelect={(file) => {
                void handleAttachConversationFile(file);
              }}
              onRemoveConversationFile={(fileId) => {
                void handleRemoveConversationFile(fileId);
              }}
              onReindexConversationFile={(fileId) => {
                void handleReindexConversationFile(fileId);
              }}
              hotSettings={{
                temperature: settingsHook.settings.temperature,
                topP: settingsHook.settings.topP,
                topK: settingsHook.settings.topK,
                maxTokens: settingsHook.settings.maxTokens,
              }}
              onPatchHotSettings={(patch) =>
                settingsHook.save({
                  ...settingsHook.settings,
                  ...patch,
                })
              }
            />
          </>
        ) : (
          <>
            {chat.error && <div className="error-banner">{chat.error}</div>}
            {(knowledge.error ||
              conversationFiles.error ||
              settingsHook.error ||
              conversationFiles.notice) && (
              <div
                className={
                  knowledge.error || conversationFiles.error || settingsHook.error
                    ? "error-banner"
                    : "notice-banner"
                }
              >
                {knowledge.error ||
                  conversationFiles.error ||
                  settingsHook.error ||
                  conversationFiles.notice}
              </div>
            )}
            <ChatView
              messages={chat.messages}
              sending={chat.sending}
              displayName={displayName}
              copiedMessageId={copiedMessageId}
              conversationId={conversationId}
              onCopy={handleCopy}
            />
            <Composer
              input={input}
              onInputChange={setInput}
              onSubmit={(hot) => { void handleSubmit(hot); }}
              sending={chat.sending}
              onStop={chat.stopGeneration}
              documents={knowledge.documents}
              conversationFiles={conversationFiles.files}
              draftAttachments={draftAttachments}
              onDraftAttachmentsChange={setDraftAttachments}
              uploading={
                knowledge.uploading || conversationFiles.uploading
              }
              uploadState={
                conversationFiles.uploadState ?? knowledge.uploadState
              }
              onAttachFileSelect={(file) => {
                void handleAttachConversationFile(file);
              }}
              onRemoveConversationFile={(fileId) => {
                void handleRemoveConversationFile(fileId);
              }}
              onReindexConversationFile={(fileId) => {
                void handleReindexConversationFile(fileId);
              }}
              hotSettings={{
                temperature: settingsHook.settings.temperature,
                topP: settingsHook.settings.topP,
                topK: settingsHook.settings.topK,
                maxTokens: settingsHook.settings.maxTokens,
              }}
              onPatchHotSettings={(patch) =>
                settingsHook.save({
                  ...settingsHook.settings,
                  ...patch,
                })
              }
            />
          </>
        )}
      </section>

      <AlertDialog
        open={duplicateNotice != null}
        title="资料库已有相同内容"
        description={
          duplicateNotice
            ? `未重复入库。已有资料：「${duplicateNotice.name}」${
                duplicateNotice.originalName &&
                duplicateNotice.originalName !== duplicateNotice.name
                  ? `（原文件 ${duplicateNotice.originalName}）`
                  : ""
              }。去重按文件内容，与显示名称无关。`
            : ""
        }
        confirmLabel="知道了"
        onClose={() => setDuplicateNotice(null)}
      />

      <ConfirmDialog
        open={pendingDelete != null}
        title={
          pendingDelete?.type === "knowledge" ? "删除本地资料" : "删除本地对话"
        }
        description={
          pendingDelete?.type === "knowledge"
            ? "将删除这份资料及其索引，此操作无法撤销。"
            : "将删除这条对话及其会话附件，此操作无法撤销。"
        }
        confirmLabel="删除"
        cancelLabel="取消"
        onConfirm={() => {
          void confirmPendingDelete();
        }}
        onCancel={() => setPendingDelete(null)}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setDisplayName(readStoredDisplayName());
        }}
        connected={chat.connected}
        runtimeSettings={settingsHook.settings}
        defaults={settingsHook.defaults}
        appliedMaxContext={settingsHook.appliedMaxContext}
        maxContextRestartRequired={settingsHook.maxContextRestartRequired}
        displayName={displayName}
        onDisplayNameChange={setDisplayName}
        settingsError={settingsHook.error}
        onSaveSettings={async (s) => {
          const result = await settingsHook.save(s);
          return result;
        }}
        onCheckStatus={() => { void chat.checkStatus(); }}
      />
    </main>
    <DocumentPreviewShell />
    </DocumentPreviewProvider>
  );
}

