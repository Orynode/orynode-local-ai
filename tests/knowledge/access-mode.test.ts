import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveKnowledgeAccessMode,
  isDocumentReadIntent,
  isDocumentSummarizeIntent,
  isCasualChatQuery,
  isSingleSourceScope,
  scopeSummary,
} from "../../services/knowledge/application/access-mode";

test("isCasualChatQuery: 寒暄跳过，事实问答不跳过", () => {
  assert.equal(isCasualChatQuery("你好"), true);
  assert.equal(isCasualChatQuery("hello!"), true);
  assert.equal(isCasualChatQuery("zend内存池是什么"), false);
  assert.equal(isCasualChatQuery("这篇讲了什么"), false);
});

test("access mode: 单文件问答与文档级读取分流", () => {
  const scope = {
    mode: "sources" as const,
    library: { documentIds: ["d1"] },
  };
  assert.equal(resolveKnowledgeAccessMode(scope, "发布日期是什么"), "document_qa");
  assert.equal(resolveKnowledgeAccessMode(scope, "总结这篇口播"), "document_read");
  assert.equal(resolveKnowledgeAccessMode(scope, "这篇讲了什么"), "document_read");
  assert.equal(resolveKnowledgeAccessMode(scope, "分析这篇口播"), "document_qa");
  assert.equal(resolveKnowledgeAccessMode(scope, "翻译这篇"), "document_qa");
  assert.equal(resolveKnowledgeAccessMode(scope, "把全文发给我"), "document_qa");
});

test("summarize intent 不把翻译/分析当成 Wiki 读页", () => {
  assert.equal(isDocumentSummarizeIntent("总结这篇资料"), true);
  assert.equal(isDocumentSummarizeIntent("overview of this doc"), true);
  assert.equal(isDocumentSummarizeIntent("翻译这篇"), false);
  assert.equal(isDocumentSummarizeIntent("分析这篇口播"), false);
  assert.equal(isDocumentReadIntent("翻译这篇"), true);
  assert.equal(isDocumentReadIntent("分析这篇口播"), true);
  assert.equal(isDocumentReadIntent("总结这篇资料"), true);
});

test("access mode: 多选对比走证据通道，整库事实问答才 multi_document", () => {
  assert.equal(
    resolveKnowledgeAccessMode(
      {
        mode: "sources",
        library: { documentIds: ["d1", "d2"] },
      },
      "对比两篇文档",
    ),
    "document_qa",
  );
  assert.equal(
    resolveKnowledgeAccessMode(
      { mode: "sources", library: "all" },
      "搜索内容",
    ),
    "multi_document",
  );
});

test("access mode: 意图优先于 library:all", () => {
  const workspace = { mode: "sources" as const, library: "all" as const };
  assert.equal(resolveKnowledgeAccessMode(workspace, "总结资料库"), "document_read");
  assert.equal(resolveKnowledgeAccessMode(workspace, "这篇讲了什么"), "document_read");
  assert.equal(
    resolveKnowledgeAccessMode(workspace, "zend内存池是什么"),
    "multi_document",
  );
  assert.equal(resolveKnowledgeAccessMode(workspace, "翻译这篇"), "document_qa");
  assert.equal(isSingleSourceScope(workspace), false);
  assert.equal(
    isSingleSourceScope({
      mode: "sources",
      library: { documentIds: ["d1"] },
    }),
    true,
  );
});

test("scope summary 不扩大授权范围", () => {
  assert.deepEqual(
    scopeSummary({
      mode: "sources",
      library: { documentIds: ["d1"] },
      conversationFiles: { conversationId: "c1", fileIds: ["f1"] },
    }),
    {
      libraryMode: "documents",
      documentCount: 1,
      conversationFileCount: 1,
    },
  );
});
