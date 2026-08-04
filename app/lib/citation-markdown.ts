/**
 * Citation → Markdown 展示适配（UI 侧）。
 *
 * 职责：
 * - 把协议正文变成 react-markdown 可识别的 citation: 链接
 * - 放行 citation: 协议（defaultUrlTransform 会清空它）
 *
 * 不负责落库。落库正文 / referencedCitationIds 仅由 useChat.finalizeAnswer 写入。
 * 本函数可对已规范正文幂等执行（流式原文、历史中段标记都靠这里出胶囊）。
 *
 * providedCitations（message.citations）= 胶囊 popover 的元数据 lookup；
 * referencedCitationIds 是落库字段，展示层不消费。
 */

import { defaultUrlTransform } from "react-markdown";
import {
  canonicalizeAssistantCitations,
  toCitationMarkdownLinks,
} from "../../services/chat/prompt";
import type { MessageCitation } from "../../services/types";

export const CITATION_HREF_PREFIX = "citation:";

export function citationUrlTransform(url: string): string {
  if (url.startsWith(CITATION_HREF_PREFIX)) return url;
  return defaultUrlTransform(url);
}

/** 解析 `citation:S5` 或合并组 `citation:S5,S7,S1` */
export function citationIdsFromHref(href: string | undefined | null): string[] {
  if (!href?.startsWith(CITATION_HREF_PREFIX)) return [];
  const rest = href.slice(CITATION_HREF_PREFIX.length);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of rest.split(/[,，]/)) {
    const id = part.trim();
    if (!/^S\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 展示用 markdown。无 provided citations 时原样返回（无法做 lookup / 过滤）。
 */
export function prepareAssistantCitationMarkdown(
  content: string,
  citations: MessageCitation[] | undefined,
): string {
  const allowedIds = (citations ?? []).map((item) => item.id);
  if (allowedIds.length === 0) return content;

  const { content: canonical } = canonicalizeAssistantCitations(
    content,
    allowedIds,
  );
  return toCitationMarkdownLinks(canonical, allowedIds);
}
