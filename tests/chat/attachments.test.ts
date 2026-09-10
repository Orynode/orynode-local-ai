import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_GROUNDING,
  allDocumentsAttachment,
  displayMessageAttachments,
  groundingFromLibrarySelection,
  hasSearchableLibrary,
  resolveRetrievalScope,
  scopeFromAttachments,
  togglePinnedDocument,
} from "../../app/lib/attachments";

test("resolveRetrievalScope: 工作区有资料时默认整库，不依赖附件", () => {
  assert.deepEqual(
    resolveRetrievalScope({
      grounding: WORKSPACE_GROUNDING,
      attachments: [],
      conversationId: null,
      hasSearchableLibrary: true,
    }),
    { mode: "sources", library: "all" },
  );
});

test("resolveRetrievalScope: 工作区没有可检索文档时不查资料库", () => {
  assert.deepEqual(
    resolveRetrievalScope({
      grounding: WORKSPACE_GROUNDING,
      attachments: [],
      conversationId: null,
      hasSearchableLibrary: false,
    }),
    { mode: "none" },
  );
});

test("resolveRetrievalScope: 关掉资料库后只保留会话附件", () => {
  assert.deepEqual(
    resolveRetrievalScope({
      grounding: { mode: "off" },
      attachments: [{ kind: "conversation_file", id: "f1", name: "a.pdf" }],
      conversationId: "c1",
      hasSearchableLibrary: true,
    }),
    {
      mode: "sources",
      conversationFiles: { conversationId: "c1", fileIds: ["f1"] },
    },
  );
});

test("resolveRetrievalScope: 钉住单篇是收窄，不是打开知识", () => {
  assert.deepEqual(
    resolveRetrievalScope({
      grounding: { mode: "pins", documentIds: ["d1"] },
      attachments: [],
      conversationId: null,
      hasSearchableLibrary: true,
    }),
    { mode: "sources", library: { documentIds: ["d1"] } },
  );
});

test("hasSearchableLibrary: 处理中的文档不算可检索", () => {
  assert.equal(hasSearchableLibrary([{ status: "processing", chunkCount: 0 }]), false);
  assert.equal(hasSearchableLibrary([{ status: "indexed", chunkCount: 12 }]), true);
});

test("togglePinnedDocument: 从工作区点一篇进入收窄，取消最后一篇回到工作区", () => {
  const pinned = togglePinnedDocument(WORKSPACE_GROUNDING, "d1");
  assert.deepEqual(pinned, { mode: "pins", documentIds: ["d1"] });
  assert.deepEqual(togglePinnedDocument(pinned, "d1"), WORKSPACE_GROUNDING);
});

test("groundingFromLibrarySelection: 全选等于工作区，子集才钉住", () => {
  assert.deepEqual(
    groundingFromLibrarySelection(["a", "b"], ["a", "b"]),
    WORKSPACE_GROUNDING,
  );
  assert.deepEqual(groundingFromLibrarySelection(["a"], ["a", "b"]), {
    mode: "pins",
    documentIds: ["a"],
  });
});

test("displayMessageAttachments: 工作区默认不写 library_all", () => {
  assert.equal(
    displayMessageAttachments({
      grounding: WORKSPACE_GROUNDING,
      attachments: [],
      documents: [{ id: "d1", name: "PHP" }],
    }),
    undefined,
  );
  assert.deepEqual(
    displayMessageAttachments({
      grounding: { mode: "pins", documentIds: ["d1"] },
      attachments: [{ kind: "conversation_file", id: "f1", name: "n.pdf" }],
      documents: [{ id: "d1", name: "PHP" }],
    }),
    [
      { kind: "conversation_file", id: "f1", name: "n.pdf" },
      { kind: "library", id: "d1", name: "PHP" },
    ],
  );
});

test("scopeFromAttachments: 旧消息的 library_all 仍能还原整库", () => {
  assert.deepEqual(
    scopeFromAttachments([allDocumentsAttachment()], null),
    { mode: "sources", library: "all" },
  );
  assert.deepEqual(scopeFromAttachments([], null), { mode: "none" });
});
