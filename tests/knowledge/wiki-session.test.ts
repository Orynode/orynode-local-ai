import assert from "node:assert/strict";
import test from "node:test";
import {
  wikiCompileJobMatches,
  wikiCompileRequestUrl,
  wikiSessionAccess,
  wikiSourcePreviewIntent,
} from "../../app/lib/wiki-session";

test("wikiCompileRequestUrl: 会话附件页走 conversation wiki", () => {
  const url = wikiCompileRequestUrl({
    page: {
      id: "mirror:conversation:file-1",
      namespace: "conversation",
      sourceDocumentId: "file-1",
    },
    conversationId: "c1",
    fileId: "file-1",
    libraryDocumentId: "doc-1",
  });
  assert.equal(url, "/api/conversations/c1/files/file-1/wiki");
});

test("wikiCompileRequestUrl: 资料库篇走 knowledge/:id，概念页走 pages/:id", () => {
  assert.equal(
    wikiCompileRequestUrl({
      page: {
        id: "mirror:library:doc-1",
        namespace: "library",
        sourceDocumentId: "doc-1",
      },
      libraryDocumentId: "doc-1",
    }),
    "/api/knowledge/doc-1/wiki",
  );
  assert.equal(
    wikiCompileRequestUrl({
      page: {
        id: "concept:tls",
        namespace: "library",
        sourceDocumentId: "concept:tls",
      },
    }),
    "/api/knowledge/wiki/pages/concept%3Atls",
  );
});

test("wikiCompileRequestUrl: settle 打开的会话页带 access query", () => {
  assert.equal(
    wikiCompileRequestUrl({
      page: {
        id: "mirror:conversation:file-1",
        namespace: "conversation",
        sourceDocumentId: "file-1",
      },
      conversationId: "c1",
    }),
    "/api/knowledge/wiki/pages/mirror%3Aconversation%3Afile-1?conversationId=c1&fileId=file-1",
  );
});

test("wikiSessionAccess: 仅会话命名空间才带 conversation 凭证", () => {
  assert.equal(
    wikiSessionAccess({
      conversationId: "c1",
      pageNamespace: "library",
    }),
    undefined,
  );
  assert.deepEqual(
    wikiSessionAccess({
      conversationId: "c1",
      pageNamespace: "conversation",
      pageSourceDocumentId: "file-1",
    }),
    { conversationId: "c1", fileId: "file-1" },
  );
});

test("wikiCompileJobMatches: 对 pageId / 源文档 / 附件任一命中", () => {
  const job = {
    type: "compile_wiki",
    status: "running",
    documentId: "file-1",
    payload: { pageId: "mirror:conversation:file-1" },
  };
  assert.equal(
    wikiCompileJobMatches(job, { pageId: "mirror:conversation:file-1" }),
    true,
  );
  assert.equal(wikiCompileJobMatches(job, { fileId: "file-1" }), true);
  assert.equal(
    wikiCompileJobMatches(
      { ...job, status: "succeeded" },
      { pageId: "mirror:conversation:file-1" },
    ),
    false,
  );
  assert.equal(
    wikiCompileJobMatches(
      { ...job, type: "compile_wiki_outlines" },
      { libraryDocumentId: "file-1" },
    ),
    false,
  );
});

test("wikiSourcePreviewIntent: 会话页默认同附件，跨文档节走资料库", () => {
  const section = {
    heading: "安装",
    excerpt: "",
    chunkId: "c1",
    pageNumber: 2,
    startLine: 4,
    endLine: 8,
  };
  const conversation = wikiSourcePreviewIntent({
    section,
    page: { namespace: "conversation", sourceDocumentId: "file-1", title: "笔记" },
    conversationFile: { id: "file-1", name: "笔记.md", conversationId: "c1" },
  });
  assert.deepEqual(conversation, {
    documentId: "file-1",
    sourceType: "conversation_file",
    conversationId: "c1",
    title: "笔记.md",
    page: 2,
    startLine: 4,
    endLine: 8,
  });
  const library = wikiSourcePreviewIntent({
    section: { ...section, sourceDocumentId: "doc-2", sourceDocumentTitle: "手册" },
    page: { namespace: "conversation", sourceDocumentId: "file-1" },
    conversationFile: { id: "file-1", name: "笔记.md", conversationId: "c1" },
  });
  assert.equal(library?.sourceType, "library");
  assert.equal(library?.documentId, "doc-2");
  assert.equal(library?.title, "手册");
});

test("wikiSourcePreviewIntent: settle 打开的会话页没有 file 时仍带 conversationId", () => {
  const preview = wikiSourcePreviewIntent({
    section: {
      heading: "安装",
      excerpt: "",
      chunkId: "c1",
      pageNumber: 1,
      sourceDocumentId: "file-1",
    },
    page: {
      namespace: "conversation",
      sourceDocumentId: "file-1",
      title: "笔记",
    },
    conversationId: "c1",
  });
  assert.equal(preview?.sourceType, "conversation_file");
  assert.equal(preview?.documentId, "file-1");
  assert.equal(preview?.conversationId, "c1");
});
