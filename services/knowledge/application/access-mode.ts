import type {
  RetrievalDiagnostics,
} from "../core/types";
import type { RetrievalScope } from "../types";

export function isDocumentReadIntent(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:总结|概括|摘要|归纳|提炼|梳理|分析|解读|评(?:价|估|析)|审阅|点评|翻译|全文|通读|主要内容|讲了什么|说了什么|对比|比较|summari[sz]e|summary|overview|analy[sz]e|analysis|review|translate|compare)/i.test(
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

/**
 * Chat / Retrieve 侧访问语义。
 * 工作台 Search 产品面在 `engine.search` 中固定为 `library_search`，不走此函数。
 */
export function resolveKnowledgeAccessMode(
  scope: RetrievalScope,
  query: string,
): NonNullable<RetrievalDiagnostics["accessMode"]> {
  const summary = scopeSummary(scope);
  const sourceCount =
    summary.documentCount + summary.conversationFileCount;
  if (summary.libraryMode === "all" || sourceCount > 1) {
    return "multi_document";
  }
  return isDocumentReadIntent(query) ? "document_read" : "document_qa";
}
