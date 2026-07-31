"use client";

import { useEffect, useState } from "react";
import type { Message } from "../services/types";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import { WelcomeScreen } from "./components/chat/WelcomeScreen";
import { Composer } from "./components/chat/Composer";
import { KnowledgeView } from "./components/knowledge/KnowledgeView";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useChat } from "./hooks/useChat";
import { useConversations } from "./hooks/useConversations";
import { useKnowledge } from "./hooks/useKnowledge";
import { useSettings } from "./hooks/useSettings";
import { Icon } from "./components/ui/Icon";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { GITHUB_REPO_URL } from "../config/defaults";
import {
  DEFAULT_DISPLAY_NAME,
  readStoredDisplayName,
} from "./lib/displayName";

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

  // ---- Hooks ----
  const chat = useChat();
  const conversations = useConversations();
  const knowledge = useKnowledge();
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

    const result = await chat.sendMessage(
      content,
      conversationId,
      conversationTitle,
      knowledge.scope,
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
    }
  }

  async function handleOpenConversation(id: string) {
    try {
      const conv = await conversations.load(id);
      setConversationId(conv.id);
      setConversationTitle(conv.title);
      chat.setMessages(conv.messages ?? []);
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
        }
        await conversations.refresh();
      } catch {
        chat.setError("删除失败");
      }
      return;
    }

    await knowledge.remove(current.id);
  }

  async function handleUploadKnowledge(file: File) {
    await knowledge.upload(file);
  }

  function handleNewChat() {
    setConversationId(null);
    setConversationTitle("");
    chat.clearChat();
    setViewMode("assistant");
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
            selectedIds={knowledge.selectedIds}
            useAllDocuments={knowledge.useAllDocuments}
            uploading={knowledge.uploading}
            reindexing={knowledge.reindexing}
            notice={knowledge.notice}
            error={knowledge.error}
            onToggle={knowledge.toggleDocument}
            onUseAll={() => {
              knowledge.setUseAllDocuments(true);
            }}
            onDelete={(id) => { void handleDeleteKnowledge(id); }}
            onReindex={(id) => { void knowledge.reindex(id); }}
            onReindexAll={() => { void knowledge.reindexAll(); }}
            onFileSelect={(file) => { void handleUploadKnowledge(file); }}
            onChatWithSelection={() => setViewMode("assistant")}
          />
        ) : chat.messages.length === 0 ? (
          <>
            <WelcomeScreen
              connected={chat.connected}
              onSuggestionClick={(text) => setInput(text)}
            />
            {knowledge.error && (
              <div className="error-banner">{knowledge.error}</div>
            )}
            <Composer
              input={input}
              onInputChange={setInput}
              onSubmit={(hot) => { void handleSubmit(hot); }}
              sending={chat.sending}
              onStop={chat.stopGeneration}
              documents={knowledge.documents}
              selectedIds={knowledge.selectedIds}
              useAllDocuments={knowledge.useAllDocuments}
              onToggleDocument={knowledge.toggleDocument}
              onUseAllDocuments={() => knowledge.setUseAllDocuments(true)}
              onClearScope={knowledge.clearScope}
              uploading={knowledge.uploading}
              onFileSelect={(file) => { void handleUploadKnowledge(file); }}
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
            {knowledge.error && (
              <div className="error-banner">{knowledge.error}</div>
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
              selectedIds={knowledge.selectedIds}
              useAllDocuments={knowledge.useAllDocuments}
              onToggleDocument={knowledge.toggleDocument}
              onUseAllDocuments={() => knowledge.setUseAllDocuments(true)}
              onClearScope={knowledge.clearScope}
              uploading={knowledge.uploading}
              onFileSelect={(file) => { void handleUploadKnowledge(file); }}
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

      <ConfirmDialog
        open={pendingDelete != null}
        title={
          pendingDelete?.type === "knowledge" ? "删除本地资料" : "删除本地对话"
        }
        description={
          pendingDelete?.type === "knowledge"
            ? "将删除这份资料及其索引，此操作无法撤销。"
            : "将删除这条对话记录，此操作无法撤销。"
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

