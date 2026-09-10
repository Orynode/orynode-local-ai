/**
 * W3：把本轮回答显式沉淀到已有大纲页。不自动新建会话百科。
 */

import type { Message, MessageCitation } from "../../types";

export type WikiSettleTarget = {
  documentId: string;
  namespace: "library" | "conversation";
  title: string;
};

function citationNamespace(
  citation: MessageCitation,
): "library" | "conversation" | null {
  const source = String(citation.sourceType || "");
  if (source === "conversation_file" || source === "conversation") {
    return "conversation";
  }
  if (source === "web" || source === "code") return null;
  return "library";
}

export function wikiSettleTargetsFromMessage(
  message: Pick<Message, "citations" | "referencedCitationIds">,
): WikiSettleTarget[] {
  const citations = message.citations ?? [];
  const referenced = new Set(message.referencedCitationIds ?? []);
  const referencedHits =
    referenced.size > 0
      ? citations.filter((item) => referenced.has(item.id))
      : [];
  const used = referencedHits.length > 0 ? referencedHits : citations;
  const seen = new Map<string, WikiSettleTarget>();
  for (const citation of used) {
    const documentId = String(citation.documentId || "").trim();
    const namespace = citationNamespace(citation);
    if (!documentId || !namespace) continue;
    const key = `${namespace}:${documentId}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      documentId,
      namespace,
      title: String(citation.title || documentId),
    });
  }
  return [...seen.values()];
}
