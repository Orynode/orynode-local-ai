"use client";

import type { ConversationSummary } from "../../../services/types";
import { Icon } from "../ui/Icon";

interface HistoryListProps {
  history: ConversationSummary[];
  currentId: string | null;
  available: boolean | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function HistoryList({
  history,
  currentId,
  available,
  onOpen,
  onDelete,
}: HistoryListProps) {
  return (
    <section className="history-section" aria-label="本地对话记录">
      <div className="history-heading">
        <span>最近对话</span>
        <small>
          {available === false
            ? "未启动"
            : available
              ? "局域网"
              : "检查中"}
        </small>
      </div>
      <div className="history-list">
        {history.map((conv) => (
          <div
            className={`history-item ${conv.id === currentId ? "selected" : ""}`}
            key={conv.id}
          >
            <button
              className="history-open"
              onClick={() => onOpen(conv.id)}
              title={conv.title}
            >
              <span>{conv.title}</span>
              <small>{conv.messageCount}条消息</small>
            </button>
            <button
              className="history-delete"
              onClick={() => onDelete(conv.id)}
              aria-label={`删除对话：${conv.title}`}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
        {available === true && history.length === 0 && (
          <p className="history-empty">暂无本地记录</p>
        )}
      </div>
    </section>
  );
}
