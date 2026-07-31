"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../../services/types";
import { Icon } from "../ui/Icon";
import { BrandLogo } from "../chat/MessageBubble";
import { HistoryList } from "./HistoryList";

interface SidebarProps {
  knowledgeCount: number;
  viewMode: "assistant" | "knowledge";
  onViewModeChange: (mode: "assistant" | "knowledge") => void;
  onNewChat: () => void;
  history: ConversationSummary[];
  currentConversationId: string | null;
  historyAvailable: boolean | null;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  displayName: string;
  onOpenSettings: () => void;
}

export function Sidebar({
  knowledgeCount,
  viewMode,
  onViewModeChange,
  onNewChat,
  history,
  currentConversationId,
  historyAvailable,
  onOpenConversation,
  onDeleteConversation,
  displayName,
  onOpenSettings,
}: SidebarProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <BrandLogo />
        </div>
        <div>
          <strong>Orynode</strong>
          <span>Local AI</span>
        </div>
      </div>

      <button className="new-chat" onClick={onNewChat}>
        <Icon name="plus" /> 新对话
      </button>

      <nav aria-label="主要功能">
        <button
          className={`nav-item ${viewMode === "assistant" ? "active" : ""}`}
          onClick={() => onViewModeChange("assistant")}
        >
          <Icon name="assistant" /> 助手
        </button>
        <button
          className={`nav-item ${viewMode === "knowledge" ? "active" : ""}`}
          onClick={() => onViewModeChange("knowledge")}
        >
          <Icon name="database" /> 本地资料库
          <small>{knowledgeCount} 篇</small>
        </button>
      </nav>

      <HistoryList
        history={history}
        currentId={currentConversationId}
        available={historyAvailable}
        onOpen={onOpenConversation}
        onDelete={onDeleteConversation}
      />

      <div className="sidebar-account" ref={accountRef}>
        {accountOpen ? (
          <div
            className="sidebar-account-popup"
            role="dialog"
            aria-label="本机身份说明"
          >
            <strong>V1 暂无用户体系</strong>
            <p>
              当前没有账号、登录或云端同步。侧栏显示的名称只保存在本机浏览器，用于对话气泡里的称呼，可在「设置」中修改。
            </p>
            <button
              type="button"
              onClick={() => {
                setAccountOpen(false);
                onOpenSettings();
              }}
            >
              打开设置改名称
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className={`sidebar-account-btn ${accountOpen ? "active" : ""}`}
          aria-expanded={accountOpen}
          aria-haspopup="dialog"
          onClick={() => setAccountOpen((open) => !open)}
        >
          <span className="sidebar-avatar" aria-hidden>
            <Icon name="robot" />
          </span>
          <span className="sidebar-account-meta">
            <strong>{displayName}</strong>
          </span>
          <span className="sidebar-account-more" aria-hidden>
            ···
          </span>
        </button>
      </div>
    </aside>
  );
}
