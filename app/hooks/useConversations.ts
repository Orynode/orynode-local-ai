"use client";

import { useCallback, useState } from "react";
import type { ConversationSummary, Message } from "../../services/types";

export function useConversations() {
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setHistory(result.conversations ?? []);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, []);

  const load = useCallback(async (id: string) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("无法读取本地对话");
    return (await response.json()).conversation as {
      id: string;
      title: string;
      messages: Message[];
    };
  }, []);

  const remove = useCallback(async (id: string) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("删除失败");
  }, []);

  return { history, available, refresh, load, remove };
}
