import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRetrievalScope } from "../../services/knowledge/retriever";
import { resolveChatRetrievalScope } from "../../services/knowledge/application/resolve-scope";

test("normalizeRetrievalScope: 空输入为 none", () => {
  assert.deepEqual(normalizeRetrievalScope(null), { mode: "none" });
  assert.deepEqual(normalizeRetrievalScope(undefined), { mode: "none" });
});

test("normalizeRetrievalScope: 兼容旧 KnowledgeScope", () => {
  assert.deepEqual(normalizeRetrievalScope({ mode: "all" }), {
    mode: "sources",
    library: "all",
  });
  assert.deepEqual(
    normalizeRetrievalScope({ mode: "documents", documentIds: ["a", "b"] }),
    { mode: "sources", library: { documentIds: ["a", "b"] } },
  );
  assert.deepEqual(
    normalizeRetrievalScope({ mode: "documents", documentIds: [] }),
    { mode: "none" },
  );
});

test("normalizeRetrievalScope: knowledgeDocumentId 兼容", () => {
  assert.deepEqual(normalizeRetrievalScope({ knowledgeDocumentId: "doc-1" }), {
    mode: "sources",
    library: { documentIds: ["doc-1"] },
  });
});

test("normalizeRetrievalScope: 双命名空间 sources", () => {
  assert.deepEqual(
    normalizeRetrievalScope({
      mode: "sources",
      library: { documentIds: ["lib-1"] },
      conversationFiles: {
        conversationId: "conv-1",
        fileIds: ["f-1", ""],
      },
    }),
    {
      mode: "sources",
      library: { documentIds: ["lib-1"] },
      conversationFiles: { conversationId: "conv-1", fileIds: ["f-1"] },
    },
  );
});

test("normalizeRetrievalScope: 无 conversationId 的附件被丢弃", () => {
  assert.deepEqual(
    normalizeRetrievalScope({
      mode: "sources",
      conversationFiles: { conversationId: "", fileIds: ["f-1"] },
    }),
    { mode: "none" },
  );
});

test("resolveChatRetrievalScope: 用顶层 conversationId 收紧附件归属", () => {
  const scope = resolveChatRetrievalScope({
    conversationId: "conv-bound",
    retrievalScope: {
      mode: "sources",
      conversationFiles: {
        conversationId: "spoofed",
        fileIds: ["f-1"],
      },
    },
  });
  assert.deepEqual(scope, {
    mode: "sources",
    conversationFiles: {
      conversationId: "conv-bound",
      fileIds: ["f-1"],
    },
  });
});

test("resolveChatRetrievalScope: 无 conversationId 时剥离会话附件", () => {
  const scope = resolveChatRetrievalScope({
    conversationId: null,
    retrievalScope: {
      mode: "sources",
      library: { documentIds: ["lib-1"] },
      conversationFiles: {
        conversationId: "conv-1",
        fileIds: ["f-1"],
      },
    },
  });
  assert.deepEqual(scope, {
    mode: "sources",
    library: { documentIds: ["lib-1"] },
  });
});

test("resolveChatRetrievalScope: 仅附件且无 conversationId → none", () => {
  const scope = resolveChatRetrievalScope({
    retrievalScope: {
      mode: "sources",
      conversationFiles: {
        conversationId: "conv-1",
        fileIds: ["f-1"],
      },
    },
  });
  assert.deepEqual(scope, { mode: "none" });
});
