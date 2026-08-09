import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveKnowledgeAccessMode,
  scopeSummary,
} from "../../services/knowledge/application/access-mode";

test("access mode: 单文件问答与文档级读取分流", () => {
  const scope = {
    mode: "sources" as const,
    library: { documentIds: ["d1"] },
  };
  assert.equal(resolveKnowledgeAccessMode(scope, "发布日期是什么"), "document_qa");
  assert.equal(resolveKnowledgeAccessMode(scope, "分析这篇口播"), "document_read");
});

test("access mode: 多选与整库都归入 multi_document", () => {
  assert.equal(
    resolveKnowledgeAccessMode(
      {
        mode: "sources",
        library: { documentIds: ["d1", "d2"] },
      },
      "对比两篇文档",
    ),
    "multi_document",
  );
  assert.equal(
    resolveKnowledgeAccessMode(
      { mode: "sources", library: "all" },
      "搜索内容",
    ),
    "multi_document",
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
