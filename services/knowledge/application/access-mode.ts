import type {
  RetrievalDiagnostics,
} from "../core/types";
import type { RetrievalScope } from "../types";

/**
 * Chat / Wiki：问句意图优先于「选了几篇」。
 * 只有「要一份概述」才走 document_read（编译页预算）。
 * 翻译 / 全文 / 分析仍走 document_qa，避免大纲摘录盖住原文。
 */
export function isDocumentSummarizeIntent(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:总结|概括|摘要|归纳|提炼|梳理|主要内容|讲了什么|说了什么|概述|summari[sz]e|summary|overview)/i.test(
    normalized,
  );
}

/**
 * 寒暄不检索资料库，避免「你好」也去翻 Wiki。
 */
export function isCasualChatQuery(query: string): boolean {
  const normalized = query.trim();
  if (!normalized) return true;
  if (normalized.length > 24) return false;
  return /^(?:你好|您好|嗨|在吗|早上好|中午好|晚上好|谢谢|感谢|ok|okay|thanks|thank you|hi|hello|hey|yo)(?:[\s,，。.!！?？~～]*)$/iu.test(
    normalized,
  );
}

/**
 * Retriever scoped_read：用户想通读 / 分析 / 翻译时放大回退窗口。
 * 不决定是否叠加 Wiki。
 */
export function isDocumentReadIntent(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  if (isDocumentSummarizeIntent(normalized)) return true;
  return /(?:分析|解读|评(?:价|估|析)|审阅|点评|翻译|全文|通读|对比|比较|analy[sz]e|analysis|review|translate|compare)/i.test(
    normalized,
  );
}

export function scopeSummary(
  scope: RetrievalScope,
): NonNullable<RetrievalDiagnostics["scopeSummary"]> {
  if (scope.mode === "none") {
    return {
      libraryMode: "none",
      documentCount: 0,
      conversationFileCount: 0,
    };
  }
  return {
    libraryMode:
      scope.library === "all"
        ? "all"
        : scope.library
          ? "documents"
          : "none",
    documentCount:
      scope.library && typeof scope.library === "object"
        ? scope.library.documentIds.length
        : 0,
    conversationFileCount: scope.conversationFiles?.fileIds.length ?? 0,
  };
}

/** 恰好一篇资料（钉住或会话附件），不是工作区 library:all。 */
export function isSingleSourceScope(scope: RetrievalScope): boolean {
  if (scope.mode !== "sources" || scope.library === "all") return false;
  const summary = scopeSummary(scope);
  return summary.documentCount + summary.conversationFileCount === 1;
}

/**
 * Chat / Retrieve 侧访问语义。意图优先于范围：
 * 概述 → document_read；翻译/全文/分析 → document_qa；其余多源/整库 → multi_document。
 * 工作台 Search 产品面在 `engine.search` 中固定为 `library_search`，不走此函数。
 */
export function resolveKnowledgeAccessMode(
  scope: RetrievalScope,
  query: string,
): NonNullable<RetrievalDiagnostics["accessMode"]> {
  if (isDocumentSummarizeIntent(query)) return "document_read";
  if (isDocumentReadIntent(query)) return "document_qa";
  const summary = scopeSummary(scope);
  const sourceCount =
    summary.documentCount + summary.conversationFileCount;
  if (summary.libraryMode === "all" || sourceCount > 1) {
    return "multi_document";
  }
  return "document_qa";
}
