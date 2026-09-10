import assert from "node:assert/strict";
import test from "node:test";
import { compileDocumentMirror } from "../../services/knowledge/wiki/compile-document-mirror";
import {
  compileConceptPages,
  conceptPageSlug,
  conceptSlugKey,
  isGenericHeading,
  mergeConceptPageForUpsert,
} from "../../services/knowledge/wiki/compile-concepts";
import {
  followWikiPages,
  mergeClusteringOutgoing,
  WIKI_FOLLOW_MAX_HOPS,
} from "../../services/knowledge/wiki/wiki-graph";
import { canReadWikiPage } from "../../services/knowledge/wiki/wiki-access";
import { wikiWriteContext } from "../../services/knowledge/wiki/wiki-http-access";
import type { ScopePolicy } from "../../services/knowledge/application/scope-policy";

test("conceptSlugKey: 去掉空白与标点", () => {
  assert.equal(conceptSlugKey("安装 / macOS"), "安装macos");
  assert.equal(isGenericHeading("第 2 页"), true);
  assert.equal(isGenericHeading("Sheet: Sheet1"), true);
  assert.equal(isGenericHeading("Sheet1"), true);
  assert.equal(isGenericHeading("工作表1"), true);
  assert.equal(isGenericHeading("Slide 1"), true);
  assert.equal(isGenericHeading("安装"), false);
  assert.equal(isGenericHeading("Sheet: 销售明细"), false);
});

test("compileConceptPages: 标题路径每一段都能归并，单篇两节也可成页", () => {
  const mirror = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-install",
    title: "手册.md",
    chunks: [
      {
        id: "a1",
        pageNumber: 1,
        headingPath: ["安装", "macOS"],
        content: "## macOS\nbrew 安装。",
      },
      {
        id: "a2",
        pageNumber: 2,
        headingPath: ["安装", "Linux"],
        content: "## Linux\napt 安装。",
      },
    ],
  });
  const { pages, links } = compileConceptPages({ mirrors: [mirror] });
  const install = pages.find((page) => page.title === "安装");
  assert.ok(install);
  assert.equal(install?.sections.length, 2);
  assert.equal(links.length, 0, "单篇资料抽出来的概念页不算相关，不建边");
  assert.equal(
    pages.some((page) => page.title === "macOS"),
    false,
  );
});

test("compileConceptPages: 两篇资料同标题才成概念页，并建 cites/part_of", () => {
  const mirrorA = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-a",
    title: "手册 A.md",
    chunks: [
      {
        id: "a1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\nA 的安装步骤。",
      },
    ],
  });
  const mirrorB = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-b",
    title: "手册 B.md",
    chunks: [
      {
        id: "b1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\nB 的安装步骤。",
      },
      {
        id: "b2",
        pageNumber: 2,
        headingPath: ["独有章节"],
        content: "## 独有章节\n只有 B 才有。",
      },
    ],
  });
  const { pages, links } = compileConceptPages({
    mirrors: [mirrorA, mirrorB],
  });
  const install = pages.find((page) => page.title === "安装");
  assert.ok(install);
  assert.equal(install?.kind, "concept");
  assert.equal(install?.compiler, "concept_cluster_v1");
  assert.equal(install?.slug, conceptPageSlug(conceptSlugKey("安装")));
  assert.match(install?.markdown ?? "", /没有调用大模型/);
  assert.equal(install?.sections.length, 2);
  assert.equal(install?.sections[0]?.sourceDocumentId, "doc-a");
  assert.ok(links.some((link) => link.rel === "cites" && link.fromId === install?.id));
  assert.ok(links.some((link) => link.rel === "part_of" && link.toId === install?.id));
  assert.equal(
    pages.some((page) => page.title === "独有章节"),
    false,
  );
});

test("compileConceptPages: Excel 默认 Sheet 名不成概念页", () => {
  const mirrorA = compileDocumentMirror({
    namespace: "library",
    documentId: "xlsx-a",
    title: "api_case",
    chunks: [
      {
        id: "a1",
        pageNumber: 1,
        headingPath: ["Sheet: Sheet1"],
        content: "## Sheet: Sheet1\n用例编号,接口",
      },
    ],
  });
  const mirrorB = compileDocumentMirror({
    namespace: "library",
    documentId: "csv-b",
    title: "sample.csv",
    chunks: [
      {
        id: "b1",
        pageNumber: 1,
        headingPath: ["Sheet: Sheet1"],
        content: "## Sheet: Sheet1\nname,value",
      },
    ],
  });
  const { pages } = compileConceptPages({
    mirrors: [mirrorA, mirrorB],
  });
  assert.equal(
    pages.some((page) => /sheet\s*1/i.test(page.title)),
    false,
  );
});

test("compileConceptPages: 单篇资料命中术语也可以成页", () => {
  const mirror = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-term",
    title: "代理.md",
    chunks: [
      {
        id: "t1",
        pageNumber: 1,
        headingPath: ["接入"],
        content: "# 接入\n请配置反向代理与证书。",
      },
    ],
  });
  const { pages } = compileConceptPages({
    mirrors: [mirror],
    terms: ["反向代理"],
  });
  assert.ok(pages.some((page) => page.title === "反向代理"));
});

test("compileConceptPages: 术语别名归并到同一稳定概念页", () => {
  const mirror = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-oop",
    title: "编程.md",
    chunks: [
      {
        id: "oop-1",
        pageNumber: 1,
        headingPath: ["设计"],
        content: "# 设计\nOOP 使用对象组织程序。",
      },
    ],
  });
  const { pages } = compileConceptPages({
    mirrors: [mirror],
    terminologyEntries: [
      { id: "object-oriented", terms: ["面向对象", "OOP"] },
    ],
  });
  const page = pages.find((item) => item.title === "面向对象");
  assert.ok(page);
  assert.deepEqual(page?.knowledge?.aliases, ["OOP"]);
  assert.equal(
    pages.some((item) => item.title === "OOP"),
    false,
  );
});

test("followWikiPages: 2 跳硬顶，不含起点", () => {
  const links = [
    { fromId: "a", toId: "b", rel: "cites" as const },
    { fromId: "b", toId: "c", rel: "cites" as const },
    { fromId: "c", toId: "d", rel: "cites" as const },
  ];
  assert.deepEqual(followWikiPages("a", links, { maxHops: WIKI_FOLLOW_MAX_HOPS }), [
    "b",
    "c",
  ]);
  assert.deepEqual(followWikiPages("a", links, { maxHops: 2, maxPages: 2 }), ["b"]);
});

test("canReadWikiPage: 已下线的对话沉淀页不可读", async () => {
  const policy = {
    async canReadDocument() {
      return true;
    },
  } as unknown as ScopePolicy;
  const allowed = await canReadWikiPage(
    {
      id: "journal:conversation:c1",
      slug: "journal:conversation:c1",
      title: "旧沉淀",
      kind: "synthesis",
      namespace: "conversation",
      sourceDocumentId: "c1",
      markdown: "x",
      sections: [],
      compiler: "conversation_settle_v1",
      status: "ready",
    },
    {
      mode: "sources",
      conversationFiles: { conversationId: "c1", fileIds: [] },
    },
    policy,
    { actor: { kind: "local-user", id: "local" }, conversationId: "c1" },
  );
  assert.equal(allowed, false);
});

test("canReadWikiPage: library:all 不能读会话大纲页", async () => {
  const policy = {
    async canReadDocument() {
      return true;
    },
  } as unknown as ScopePolicy;
  const page = {
    id: "mirror:conversation:f1",
    slug: "mirror:conversation:f1",
    title: "附件",
    kind: "document_mirror" as const,
    namespace: "conversation" as const,
    sourceDocumentId: "f1",
    markdown: "x",
    sections: [],
    compiler: "heading_path_v1",
    status: "ready" as const,
  };
  const denied = await canReadWikiPage(
    page,
    { mode: "sources", library: "all" },
    policy,
    { actor: { kind: "local-user", id: "local" } },
  );
  assert.equal(denied, false);
  const allowed = await canReadWikiPage(
    page,
    {
      mode: "sources",
      conversationFiles: { conversationId: "c1", fileIds: ["f1"] },
    },
    policy,
    { actor: { kind: "local-user", id: "local" }, conversationId: "c1" },
  );
  assert.equal(allowed, true);
});

test("wikiWriteContext: 会话写必须带 conversationId 和 fileId", () => {
  const denied = wikiWriteContext({
    namespace: "conversation",
    conversationId: "c1",
  });
  assert.equal(denied.scope.mode, "none");
  const allowed = wikiWriteContext({
    namespace: "conversation",
    conversationId: "c1",
    fileIds: ["f1"],
  });
  assert.equal(allowed.scope.mode, "sources");
});

test("run-compile-concepts: 术语表从 knowledge/query 加载，模块可解析", async () => {
  const mod = await import(
    "../../services/knowledge/wiki/run-compile-concepts.ts"
  );
  assert.equal(typeof mod.runCompileConceptsJob, "function");
});

test("mergeConceptPageForUpsert: 保留已有 claims，stale 不被写成 ready", () => {
  const mirror = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-a",
    title: "手册 A.md",
    chunks: [
      {
        id: "a1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\nA 的安装步骤。",
      },
    ],
  });
  const mirrorB = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-b",
    title: "手册 B.md",
    chunks: [
      {
        id: "b1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\nB 的安装步骤。",
      },
    ],
  });
  const compiled = compileConceptPages({ mirrors: [mirror, mirrorB] }).pages.find(
    (page) => page.title === "安装",
  );
  assert.ok(compiled);
  const merged = mergeConceptPageForUpsert(
    {
      ...compiled!,
      status: "ready",
      knowledge: {
        aliases: ["setup"],
        claims: [],
        relations: [],
      },
    },
    {
      ...compiled!,
      status: "stale",
      synthesisMarkdown: "已发布综述：安装分 macOS 与 Linux。",
      notesMarkdown: "对话沉淀：记得查权限。",
      knowledge: {
        aliases: ["install"],
        claims: [
          {
            id: "claim-1",
            text: "安装需要管理员权限",
            citationSectionIndexes: [1],
            sourceChunkIds: ["a1"],
          },
        ],
        relations: [
          {
            target: "权限",
            rel: "depends_on",
            citationSectionIndexes: [1],
            status: "resolved",
          },
        ],
      },
    },
  );
  assert.equal(merged.knowledge?.claims.length, 1);
  assert.equal(merged.knowledge?.claims[0]?.text, "安装需要管理员权限");
  assert.equal(merged.knowledge?.relations[0]?.rel, "depends_on");
  assert.equal(merged.status, "stale");
  assert.equal(merged.synthesisMarkdown, "已发布综述：安装分 macOS 与 Linux。");
  assert.ok(merged.knowledge?.aliases.includes("setup"));
  assert.ok(merged.knowledge?.aliases.includes("install"));
});

test("mergeClusteringOutgoing: 只替换 cites/see_also，保留 depends_on", () => {
  const merged = mergeClusteringOutgoing(
    [
      { fromId: "concept:install", toId: "concept:perm", rel: "depends_on" },
      { fromId: "concept:install", toId: "mirror:a", rel: "cites" },
      { fromId: "concept:install", toId: "concept:os", rel: "is_a" },
    ],
    [
      { fromId: "concept:install", toId: "mirror:b", rel: "cites" },
      { fromId: "concept:install", toId: "mirror:c", rel: "see_also" },
    ],
  );
  assert.deepEqual(
    merged.map((link) => `${link.toId}:${link.rel}`).sort(),
    ["concept:os:is_a", "concept:perm:depends_on", "mirror:b:cites", "mirror:c:see_also"],
  );
});
