"use client";

import { useEffect, useState } from "react";
import type {
  KnowledgeDocument,
  Message,
  MessageAttachment,
} from "../services/types";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import { WelcomeScreen } from "./components/chat/WelcomeScreen";
import { Composer } from "./components/chat/Composer";
import { KnowledgeView } from "./components/knowledge/KnowledgeView";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { useConversationFiles } from "./hooks/useConversationFiles";
import { useKnowledge } from "./hooks/useKnowledge";
import { useSettings } from "./hooks/useSettings";
import { Icon } from "./components/ui/Icon";
import { AlertDialog } from "./components/ui/AlertDialog";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { GITHUB_REPO_URL } from "../config/defaults";
import {
  DEFAULT_DISPLAY_NAME,
  readStoredDisplayName,
} from "./lib/displayName";
import { attachmentFromConversationFile } from "./lib/attachments";

type PendingDelete =
  | { type: "conversation"; id: string }
  | { type: "knowledge"; id: string }
  | null;

export default function Home() {
  // ---- State ----
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState("");
  const [viewMode, setViewMode] = useState<"assistant" | "knowledge">("assistant");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(DEFAULT_DISPLAY_NAME);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  /** 内容去重命中时弹窗（对话页也可见） */
  const [duplicateNotice, setDuplicateNotice] =
    useState<KnowledgeDocument | null>(null);
  /** 仅作用于下次发送；成功发送后清空，打开历史/新对话/删除当前会话不保留 */
  const [draftAttachments, setDraftAttachments] = useState<MessageAttachment[]>(
    [],
  );

  // ---- Hooks ----
  const chat = useChat();
  const conversations = useConversations();
  const knowledge = useKnowledge();
  const conversationFiles = useConversationFiles();
  const settingsHook = useSettings();

  // ---- Init ----
  useEffect(() => {
    setDisplayName(readStoredDisplayName());
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

    await knowledge.remove(current.id);
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

  async function ensureConversationId(): Promise<string> {
    if (conversationId) return conversationId;
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
    return id;
  }

  /** 附到本对话：会话附件命名空间 */
  async function handleAttachConversationFile(file: File) {
    try {
      const id = await ensureConversationId();
      const uploaded = await conversationFiles.upload(id, file);
      if (uploaded) {
        setDraftAttachments((prev) => {
          if (
            prev.some(
              (item) =>
                item.kind === "conversation_file" && item.id === uploaded.id,
            )
          ) {
            return prev;
          }
          return [...prev, attachmentFromConversationFile(uploaded)];
        });
      }
    } catch (e) {
      conversationFiles.setError(
        e instanceof Error ? e.message : "无法附到本对话",
      );
    }
  }

  function handleNewChat() {
    setConversationId(null);
    setConversationTitle("");
    chat.clearChat();
    setDraftAttachments([]);
    conversationFiles.clear();
    setViewMode("assistant");
  }

  /** 资料库「去对话」：始终新开空对话，再挂上本轮资料库草稿 */
  function handleAttachToChat(attachments: MessageAttachment[]) {
    setConversationId(null);
    setConversationTitle("");
    chat.clearChat();
    conversationFiles.clear();
    setDraftAttachments(attachments);
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
            onReindexAll={() => { void knowledge.reindexAll(); }}
            onRename={(id, name) => knowledge.rename(id, name)}
            onImport={(file, options) => {
              void handleUploadKnowledge(file, options);
            }}
            onAttachToChat={handleAttachToChat}
          />
        ) : chat.messages.length === 0 ? (
          <>
            <WelcomeScreen
              connected={chat.connected}
              onSuggestionClick={(text) => setInput(text)}
            />
            {(knowledge.error || conversationFiles.error) && (
              <div className="error-banner">
                {knowledge.error || conversationFiles.error}
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
              onImportLibrarySelect={(file) => {
                void handleUploadKnowledge(file);
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
            {(knowledge.error || conversationFiles.error) && (
              <div className="error-banner">
                {knowledge.error || conversationFiles.error}
              </div>
            )}
            <ChatView
              messages={chat.messages}
              sending={chat.sending}
              displayName={displayName}
              copiedMessageId={copiedMessageId}
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
              onImportLibrarySelect={(file) => {
                void handleUploadKnowledge(file);
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
        onSaveSettings={async (s) => {
          const result = await settingsHook.save(s);
          return result;
        }}
        onCheckStatus={() => { void chat.checkStatus(); }}
      />
    </main>
  );
}

