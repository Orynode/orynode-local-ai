import assert from "node:assert/strict";
import test from "node:test";
import {
  compileDocumentMirror,
  parseHeadingPath,
  WIKI_COMPILER_ID,
  wikiPageSlug,
} from "../../services/knowledge/wiki/compile-document-mirror";
import { hitsFromCompiledPage, wikiSynthesisHitId, wikiNotesHitId, mergeWikiRagHits, filterWikiHitsForQuery, wikiQueryNeedles } from "../../services/knowledge/wiki/load-wiki-hits";
import {
  compileAndUpsertDocumentMirror,
  mirrorStatusAfterSourceChange,
} from "../../services/knowledge/wiki/compile-and-upsert";
import {
  parseWikiCompileForce,
  wikiForceBlocked,
} from "../../services/knowledge/wiki/enqueue-compile";
import {
  buildRepairUserPrompt,
  buildSynthesisUserPrompt,
  citationNumbersInText,
  stripMarkdownFence,
  validateCompiledWikiKnowledge,
  validateSynthesisMarkdown,
} from "../../services/knowledge/wiki/compile-synthesis";
import { packWikiSections } from "../../services/knowledge/wiki/context-packer";
import { compileWikiKnowledge, reduceCompiledKnowledge } from "../../services/knowledge/wiki/knowledge-compiler";
import { assertPublishableKnowledge } from "../../services/knowledge/wiki/publish";
import { completeStructuredWikiKnowledge } from "../../services/knowledge/wiki/structured-completion";
import {
  saveWikiCandidate,
  WikiPersistError,
  WIKI_READ_TIMEOUT_MS,
  WIKI_WRITE_TIMEOUT_MS,
} from "../../services/knowledge/wiki/persist";
import { wikiSettleTargetsFromMessage } from "../../services/knowledge/wiki/settle-from-chat";
import {
  appendWikiNotes,
  normalizeSettleTargets,
  settleWikiPages,
} from "../../services/knowledge/wiki/run-settle";
import { loadWikiHitsForQuery } from "../../services/knowledge/wiki/load-wiki-hits";
import { wikiBrowseContextFromRequest } from "../../services/knowledge/wiki/wiki-http-access";
import { WIKI_LIBRARY_SCAN_CAP } from "../../services/knowledge/wiki/compile-document-mirror";

test("parseHeadingPath: 数组与 JSON 字符串", () => {
  assert.deepEqual(parseHeadingPath(["安装", "macOS"]), ["安装", "macOS"]);
  assert.deepEqual(parseHeadingPath('["安装","macOS"]'), ["安装", "macOS"]);
  assert.deepEqual(parseHeadingPath(""), []);
});

test("compileDocumentMirror: 按 headingPath 抽章节，不发明内容", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "安装说明.md",
    chunks: [
      {
        id: "c1",
        pageNumber: 1,
        position: 0,
        headingPath: ["安装"],
        content: "# 安装\n简介段落。",
      },
      {
        id: "c2",
        pageNumber: 1,
        position: 1,
        headingPath: ["安装", "macOS"],
        content: "## macOS\nbrew 安装步骤。",
      },
      {
        id: "c3",
        pageNumber: 2,
        position: 0,
        headingPath: ["安装", "Linux"],
        content: "## Linux\napt 安装步骤。",
      },
    ],
  });

  assert.equal(page.kind, "document_mirror");
  assert.equal(page.compiler, WIKI_COMPILER_ID);
  assert.equal(page.slug, wikiPageSlug("library", "doc-1"));
  assert.equal(page.sections.length, 3);
  assert.equal(page.sections[0]?.heading, "安装");
  assert.match(page.sections[0]?.excerpt ?? "", /简介段落/);
  assert.equal(page.sections[1]?.heading, "安装 / macOS");
  assert.match(page.sections[1]?.excerpt ?? "", /brew 安装步骤/);
  assert.match(page.markdown, /没有调用大模型/);
  assert.match(page.markdown, /## 安装 \/ macOS/);
  assert.doesNotMatch(page.markdown, /Gemma/);
});

test("compileDocumentMirror: 无标题时按页成节", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "pdf-1",
    title: "扫描件.pdf",
    chunks: [
      {
        id: "p1",
        pageNumber: 1,
        position: 0,
        content: "第一页正文甲。",
      },
      {
        id: "p2",
        pageNumber: 2,
        position: 0,
        content: "第二页正文乙。",
      },
    ],
  });
  assert.equal(page.sections[0]?.heading, "第 1 页");
  assert.equal(page.sections[1]?.heading, "第 2 页");
  assert.match(page.sections[0]?.excerpt ?? "", /第一页正文甲/);
});

test("hitsFromCompiledPage: 章节命中仍指向源 chunk", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "手册.md",
    chunks: [
      {
        id: "chunk-a",
        pageNumber: 3,
        headingPath: ["引用"],
        startLine: 12,
        endLine: 18,
        content: "引用协议用 [S1]。",
      },
    ],
  });
  const hits = hitsFromCompiledPage(page, "library");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, "chunk-a");
  assert.equal(hits[0]?.documentId, "doc-1");
  assert.equal(hits[0]?.pageNumber, 3);
  assert.equal(hits[0]?.startLine, 12);
  assert.match(hits[0]?.content ?? "", /引用协议/);
});

test("hitsFromCompiledPage: stale 综述不进证据窗，笔记和节仍回源", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "手册.md",
    chunks: [
      {
        id: "chunk-a",
        pageNumber: 3,
        headingPath: ["引用"],
        content: "引用协议用编号。",
      },
    ],
  });
  page.status = "stale";
  page.synthesisMarkdown = "过时综述 [S1]";
  page.notesMarkdown = "## 对话沉淀\n\n人手记下的笔记";
  const hits = hitsFromCompiledPage(page, "library");
  assert.equal(
    hits.some((hit) => hit.id === wikiSynthesisHitId(page.id)),
    false,
  );
  assert.equal(hits[0]?.id, wikiNotesHitId(page.id));
  assert.match(hits[0]?.content ?? "", /人手记下的笔记/);
  assert.equal(hits[1]?.id, "chunk-a");
});

test("hitsFromCompiledPage: 有综述时放在最前，仍指向源 chunk", () => {
  const page = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "手册.md",
    chunks: [
      {
        id: "chunk-a",
        pageNumber: 3,
        headingPath: ["引用"],
        content: "引用协议用编号。",
      },
    ],
  });
  page.synthesisMarkdown = "这份手册说明引用协议。[S1]";
  const hits = hitsFromCompiledPage(page, "library");
  assert.equal(hits.length, 2);
  assert.match(hits[0]?.content ?? "", /这份手册说明引用协议/);
  assert.equal(hits[0]?.id, wikiSynthesisHitId("mirror:library:doc-1"));
  assert.equal(hits[0]?.sourceChunkId, "chunk-a");
  assert.equal(hits[1]?.id, "chunk-a");
  assert.equal(hits[0]?.id === hits[1]?.id, false);
});

test("mergeWikiRagHits: 同 id 保留原文切片，综述仍在结果里", () => {
  const wikiHits = [
    {
      id: "mirror:library:doc-1::synthesis",
      documentId: "doc-1",
      documentName: "手册.md",
      pageNumber: 1,
      position: 0,
      content: "综述正文",
      score: 3,
      source: "library" as const,
      sourceChunkId: "chunk-a",
    },
    {
      id: "chunk-a",
      documentId: "doc-1",
      documentName: "手册.md",
      pageNumber: 1,
      position: 1,
      content: "首节摘录",
      score: 2,
      source: "library" as const,
    },
  ];
  const ragHits = [
    {
      id: "chunk-a",
      documentId: "doc-1",
      documentName: "手册.md",
      pageNumber: 1,
      position: 0,
      content: "原文切片",
      score: 1,
      source: "library" as const,
    },
  ];
  const merged = mergeWikiRagHits(wikiHits, ragHits, 8);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((hit) => hit.id === "mirror:library:doc-1::synthesis"));
  assert.ok(merged.some((hit) => hit.id === "chunk-a"));
  const chunk = merged.find((hit) => hit.id === "chunk-a");
  assert.equal(chunk?.content, "原文切片");
});

test("wikiQueryNeedles: 走 MATCH 内容词，不含问句词「什么」", () => {
  const needles = wikiQueryNeedles("zend内存池是什么", [
    "Zend Memory Manager",
  ]);
  assert.ok(needles.some((item) => item.toLowerCase().includes("zend")));
  assert.ok(needles.some((item) => item.includes("内存池")));
  assert.equal(needles.includes("什么"), false);
});

test("filterWikiHitsForQuery: 问句不能把小说大纲当成 Zend 证据", () => {
  const hits = [
    {
      id: "novel-1",
      documentId: "novel",
      documentName: "百年孤独",
      pageNumber: 1,
      position: 0,
      content: "多年以后，面对行刑队，他想起了什么是冰块。",
      score: 9,
      source: "library" as const,
    },
    {
      id: "php-1",
      documentId: "php",
      documentName: "PHP7内核剖析",
      pageNumber: 40,
      position: 0,
      content: "Zend 内存管理器把请求内存交给内存池分配。",
      score: 4,
      source: "library" as const,
    },
  ];
  const kept = filterWikiHitsForQuery(hits, "zend内存池是什么");
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, "php-1");
});

test("filterWikiHitsForQuery: 同书目录节让给打分更高的内存管理节", () => {
  const hits = [
    {
      id: "toc",
      documentId: "php",
      documentName: "PHP7内核剖析",
      pageNumber: 3,
      position: 0,
      content: "## 第 3 页\n3.4 魔术方法 3.5 运行时缓存 第4章 PHP基础语法",
      score: 9,
      source: "library" as const,
    },
    {
      id: "mm",
      documentId: "php",
      documentName: "PHP7内核剖析",
      pageNumber: 40,
      position: 1,
      content: "Zend 内存管理器把请求内存交给内存池分配。",
      score: 2,
      source: "library" as const,
    },
  ];
  const kept = filterWikiHitsForQuery(hits, "zend内存池是什么");
  assert.ok(kept.length >= 1);
  assert.equal(kept[0]?.id, "mm");
});

test("mergeWikiRagHits: Wiki 大纲不得靠前置挤掉 RAG 原文", () => {
  const wikiHits = Array.from({ length: 8 }, (_, index) => ({
    id: `novel-${index}`,
    documentId: "novel",
    documentName: "百年孤独",
    pageNumber: index + 1,
    position: index,
    content: `小说第 ${index + 1} 页`,
    score: 15 - index,
    source: "library" as const,
  }));
  const ragHits = [
    {
      id: "php-chunk",
      documentId: "php",
      documentName: "PHP7内核剖析",
      pageNumber: 40,
      position: 0,
      content: "zend_mm 内存池",
      score: 1,
      source: "library" as const,
    },
  ];
  const merged = mergeWikiRagHits(wikiHits, ragHits, 8);
  assert.equal(merged[0]?.id, "php-chunk");
  assert.ok(merged.some((hit) => hit.id === "php-chunk"));
});

test("mirrorStatusAfterSourceChange: 有综述（含人手改）都标过时", () => {
  assert.equal(mirrorStatusAfterSourceChange(null), "ready");
  assert.equal(mirrorStatusAfterSourceChange({}), "ready");
  assert.equal(
    mirrorStatusAfterSourceChange({ synthesisMarkdown: "旧综述 [S1]" }),
    "stale",
  );
});

test("validateSynthesisMarkdown: 必须带合法 [S#]", () => {
  const ok = validateSynthesisMarkdown(
    "这份资料主要讲安装。macOS 用 Homebrew 完成基础环境，装好后先跑一遍检查。[S1]\n\nLinux 则换成发行版自带的包管理器，步骤和 macOS 不同，不要混用命令。[S2]",
    2,
  );
  assert.match(ok, /安装/);
  assert.deepEqual(citationNumbersInText(ok), [1, 2]);
  assert.equal(
    stripMarkdownFence(
      "```md\nhello world 综述正文要够长才过线啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊\n```",
    ).startsWith("hello"),
    true,
  );
  assert.throws(
    () => validateSynthesisMarkdown("太短。", 2),
    /WIKI_SYNTHESIS_TOO_SHORT/,
  );
  assert.throws(
    () =>
      validateSynthesisMarkdown(
        `${"没有依据的长段落，".repeat(12)}所以不能入库。`,
        2,
      ),
    /WIKI_SYNTHESIS_NO_CITATION/,
  );
  assert.throws(
    () =>
      validateSynthesisMarkdown(
        `${"模型引用了不存在的章节。".repeat(6)}编号超出大纲。[S9]`,
        2,
      ),
    /WIKI_SYNTHESIS_BAD_CITATION/,
  );
  const prompt = buildSynthesisUserPrompt({
    title: "安装说明",
    sections: [
      {
        heading: "macOS",
        excerpt: "brew 安装",
        chunkId: "c1",
        pageNumber: 1,
        headingPath: ["macOS"],
      },
    ],
  });
  assert.match(prompt, /\[S1\]/);
  assert.match(prompt, /安装说明/);
  assert.match(prompt, /UNTRUSTED_SOURCE/);
  assert.throws(
    () =>
      validateSynthesisMarkdown(
        `${"第一段有出处。".repeat(6)}[S1]\n\n${"第二段完全没有引用编号。".repeat(6)}`,
        2,
      ),
    /WIKI_SYNTHESIS_UNCITED_PARAGRAPH/,
  );
  const conceptPrompt = buildSynthesisUserPrompt({
    title: "安装",
    kind: "concept",
    sections: [
      {
        heading: "macOS",
        excerpt: "brew 安装",
        chunkId: "c1",
        pageNumber: 1,
        headingPath: ["macOS"],
        sourceDocumentTitle: "手册 A",
      },
    ],
  });
  assert.match(conceptPrompt, /概念标题：安装/);
  assert.match(conceptPrompt, /共同说法/);
  assert.match(conceptPrompt, /手册 A/);
});

test("validateCompiledWikiKnowledge: 编译结构化主张并绑定源 chunk", () => {
  const compiled = validateCompiledWikiKnowledge(
    JSON.stringify({
      articleMarkdown:
        "反向代理位于客户端与服务端之间，并把收到的请求转发给后端服务，从而形成统一的服务入口。[S1]\n\n它可以集中处理 TLS 连接与证书配置，但具体参数仍然取决于资料描述的部署环境，不能跨环境直接照搬。[S2]",
      aliases: ["reverse proxy"],
      claims: [
        {
          text: "反向代理把客户端请求转发给后端服务",
          kind: "definition",
          citations: [1],
        },
      ],
      relations: [
        { target: "TLS", rel: "related_to", citations: ["S2"] },
      ],
    }),
    [
      {
        heading: "定义",
        excerpt: "请求转发",
        chunkId: "chunk-definition",
        pageNumber: 1,
        headingPath: ["定义"],
      },
      {
        heading: "TLS",
        excerpt: "集中处理 TLS",
        chunkId: "chunk-tls",
        pageNumber: 2,
        headingPath: ["TLS"],
      },
    ],
  );
  assert.equal(compiled.knowledge.claims.length, 1);
  assert.deepEqual(compiled.knowledge.claims[0]?.sourceChunkIds, [
    "chunk-definition",
  ]);
  assert.deepEqual(compiled.knowledge.aliases, ["reverse proxy"]);
  assert.equal(compiled.knowledge.relations[0]?.rel, "related_to");
  assert.ok(compiled.knowledge.claims[0]?.fingerprint);
});

test("wiki persist: 写入超时长于读取，硬顶可见", () => {
  assert.equal(WIKI_READ_TIMEOUT_MS, 2500);
  assert.ok(WIKI_WRITE_TIMEOUT_MS >= 15_000);
  assert.ok(WIKI_WRITE_TIMEOUT_MS > WIKI_READ_TIMEOUT_MS);
  assert.equal(WIKI_LIBRARY_SCAN_CAP, 500);
});

test("wikiSettleTargetsFromMessage: 按引用文档去重，忽略网页", () => {
  const targets = wikiSettleTargetsFromMessage({
    citations: [
      {
        id: "S1",
        documentId: "doc-1",
        revisionId: "r1",
        processingBuildId: "b1",
        title: "手册",
        sourceType: "library",
        locator: { kind: "page", page: 1 },
        excerpt: "安装",
      },
      {
        id: "S2",
        documentId: "doc-1",
        revisionId: "r1",
        processingBuildId: "b1",
        title: "手册",
        sourceType: "library",
        locator: { kind: "page", page: 2 },
        excerpt: "检查",
      },
      {
        id: "S3",
        documentId: "https://example.com",
        revisionId: "r1",
        processingBuildId: "b1",
        title: "外链",
        sourceType: "web",
        locator: { kind: "web", url: "https://example.com" },
        excerpt: "网页",
      },
    ],
    referencedCitationIds: ["S1", "S2", "S3"],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.documentId, "doc-1");
  assert.equal(targets[0]?.namespace, "library");
});

test("wikiSettleTargetsFromMessage: referenced id 对不上时回退全部引用", () => {
  const targets = wikiSettleTargetsFromMessage({
    citations: [
      {
        id: "S1",
        documentId: "doc-1",
        revisionId: "r1",
        processingBuildId: "b1",
        title: "手册",
        sourceType: "library",
        locator: { kind: "page", page: 1 },
        excerpt: "安装",
      },
    ],
    referencedCitationIds: ["1"],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.documentId, "doc-1");
});

test("runCompileWikiJob: 概念页不重抽文档大纲，也不伪装 chatActive", async () => {
  const { runCompileWikiJob } = await import(
    "../../services/knowledge/wiki/run-compile-wiki.ts"
  );
  let fetchChunksCalled = false;
  const upserted: Array<{
    synthesisMarkdown?: string;
    kind?: string;
    knowledge?: { claims?: unknown[] };
  }> = [];
  const result = await runCompileWikiJob({
    payload: {
      pageId: "concept:library:install",
      documentId: "concept:install",
      force: true,
    },
    tryAcquireWiki: () => ({ ok: true, leaseId: "lease-1" }),
    releaseWiki: () => undefined,
    fetchChunks: async () => {
      fetchChunksCalled = true;
      return [];
    },
    fetchPageById: async () => ({
      id: "concept:library:install",
      slug: "concept:library:install",
      title: "安装",
      kind: "concept",
      namespace: "library",
      sourceDocumentId: "concept:install",
      markdown: "# 安装",
      sections: [
        {
          heading: "macOS",
          excerpt: "brew",
          chunkId: "c1",
          pageNumber: 1,
          headingPath: ["macOS"],
        },
      ],
      compiler: "concept_cluster_v1",
      status: "ready",
    }),
    upsertPage: async (page) => {
      upserted.push(page);
      return page;
    },
    completeSynthesis: async () =>
      JSON.stringify({
        articleMarkdown:
          "这些资料都把安装分成 macOS 与发行版两条路径，共同点是先装包管理器再做一次环境检查。[S1]\n差异在命令本身：不要把 brew 的步骤套到 Linux，也不要把发行版包管理器的参数抄回 macOS。[S1]",
        aliases: ["安装"],
        claims: [
          {
            text: "安装先装包管理器再做环境检查",
            kind: "process",
            citations: [1],
          },
        ],
        relations: [],
      }),
    recordCompileRun: async () => true,
  });
  assert.equal(fetchChunksCalled, false);
  assert.equal(result.deferred, undefined);
  if ("pageId" in result) {
    assert.equal(result.pageId, "concept:library:install");
  }
  assert.equal(upserted.length, 1);
  assert.match(upserted[0]?.synthesisMarkdown ?? "", /包管理器/);
  assert.equal(upserted[0]?.knowledge?.claims?.length, 1);
});

const SAMPLE_SECTIONS = [
  {
    heading: "macOS",
    excerpt: "brew 安装包管理器并检查环境",
    chunkId: "c1",
    pageNumber: 1,
    headingPath: ["macOS"],
  },
];

function sampleKnowledgeJson(citations: number[] = [1]) {
  return JSON.stringify({
    articleMarkdown:
      "这些资料都把安装分成 macOS 与发行版两条路径，共同点是先装包管理器再做一次环境检查。[S1]\n差异在命令本身：不要把 brew 的步骤套到 Linux，也不要把发行版包管理器的参数抄回 macOS。[S1]",
    aliases: ["install"],
    claims: [
      {
        text: "安装先装包管理器再做环境检查",
        kind: "process",
        citations,
      },
    ],
    relations: [],
  });
}

test("packWikiSections: 按 token 分批并保留原章节编号", () => {
  const sections = Array.from({ length: 12 }, (_, index) => ({
    heading: `第${index + 1}节`,
    excerpt: "这是一段足够长的摘录，用来把单批 token 预算打满以便拆成多批。".repeat(8),
    chunkId: `c${index + 1}`,
    pageNumber: index + 1,
    headingPath: [`h${index + 1}`],
  }));
  const packed = packWikiSections(sections, {
    inputBudgetTokens: 400,
    excerptMaxTokens: 80,
    maxBatches: 3,
  });
  assert.ok(packed.batches.length >= 2);
  assert.equal(packed.sections[0]?.globalIndex, 1);
  assert.equal(
    packed.batches.flatMap((batch) => batch.sections).every((section) => section.globalIndex >= 1),
    true,
  );
});

test("completeStructuredWikiKnowledge: 首次非法 JSON 后 repair 一次", async () => {
  let calls = 0;
  const result = await completeStructuredWikiKnowledge({
    complete: async () => {
      calls += 1;
      if (calls === 1) return "not-json";
      return sampleKnowledgeJson();
    },
    system: "sys",
    user: "user",
    sections: SAMPLE_SECTIONS,
    buildRepairUser: (input) => {
      assert.match(input.error, /WIKI_KNOWLEDGE_NOT_JSON/);
      return buildRepairUserPrompt(input);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.repaired, true);
  assert.equal(result.compiled.knowledge.claims.length, 1);
});

test("completeStructuredWikiKnowledge: 两次都失败则抛错", async () => {
  await assert.rejects(
    () =>
      completeStructuredWikiKnowledge({
        complete: async () => "not-json",
        system: "sys",
        user: "user",
        sections: SAMPLE_SECTIONS,
        buildRepairUser: buildRepairUserPrompt,
      }),
    /WIKI_KNOWLEDGE_NOT_JSON/,
  );
});

test("reduceCompiledKnowledge: 相同主张合并出处", () => {
  const a = validateCompiledWikiKnowledge(sampleKnowledgeJson([1]), [
    ...SAMPLE_SECTIONS,
    {
      heading: "Linux",
      excerpt: "apt 安装",
      chunkId: "c2",
      pageNumber: 2,
      headingPath: ["Linux"],
    },
  ]);
  const b = validateCompiledWikiKnowledge(
    JSON.stringify({
      articleMarkdown:
        "Linux 发行版用自带包管理器完成安装，不要把 brew 命令抄过去。[S2]\n这条路径和 macOS 并列，而不是互相替代，实际命令必须跟资料里的发行版走。[S2]",
      aliases: ["安装"],
      claims: [
        {
          text: "安装先装包管理器再做环境检查",
          kind: "process",
          citations: [2],
        },
      ],
      relations: [],
    }),
    [
      ...SAMPLE_SECTIONS,
      {
        heading: "Linux",
        excerpt: "apt 安装",
        chunkId: "c2",
        pageNumber: 2,
        headingPath: ["Linux"],
      },
    ],
  );
  const reduced = reduceCompiledKnowledge([a, b]);
  assert.equal(reduced.knowledge.claims.length, 1);
  assert.deepEqual(reduced.knowledge.claims[0]?.citationSectionIndexes, [1, 2]);
  assert.deepEqual(
    (reduced.knowledge.claims[0]?.evidence ?? []).map((item) => item.chunkId).sort(),
    ["c1", "c2"],
  );
  assert.ok(reduced.knowledge.aliases.includes("install"));
});

test("assertPublishableKnowledge: 没有证据的主张不得发布", () => {
  assert.throws(
    () =>
      assertPublishableKnowledge(
        {
          articleMarkdown: `${"没有出处的长段落。".repeat(12)}`,
          knowledge: {
            aliases: [],
            claims: [
              {
                id: "claim-1",
                text: "无证据",
                citationSectionIndexes: [1],
                sourceChunkIds: [],
              },
            ],
            relations: [],
          },
        },
        SAMPLE_SECTIONS,
      ),
    /WIKI_KNOWLEDGE_NO_EVIDENCE/,
  );
});

test("runCompileWikiJob: 校验失败不写半成品", async () => {
  const { runCompileWikiJob } = await import(
    "../../services/knowledge/wiki/run-compile-wiki.ts"
  );
  const upserted: unknown[] = [];
  const runs: Array<{ status?: string }> = [];
  await assert.rejects(
    () =>
      runCompileWikiJob({
        payload: {
          pageId: "mirror:library:doc-1",
          documentId: "doc-1",
        },
        tryAcquireWiki: () => ({ ok: true, leaseId: "lease-1" }),
        releaseWiki: () => undefined,
        fetchPageById: async () => ({
          id: "mirror:library:doc-1",
          slug: "mirror:library:doc-1",
          title: "手册",
          kind: "document_mirror",
          namespace: "library",
          sourceDocumentId: "doc-1",
          markdown: "# 手册",
          sections: SAMPLE_SECTIONS,
          compiler: "heading_extract_v1",
          status: "ready",
          synthesisMarkdown: "旧综述仍然保留 [S1]",
        }),
        upsertPage: async (page) => {
          upserted.push(page);
          return page;
        },
        recordCompileRun: async (run) => {
          runs.push(run);
          return true;
        },
        complete: async () => "not-json",
      }),
    /WIKI_KNOWLEDGE_NOT_JSON/,
  );
  assert.equal(upserted.length, 0);
  assert.equal(runs[0]?.status, "failed");
});

test("compileWikiKnowledge: 单批成功写出主张", async () => {
  const result = await compileWikiKnowledge({
    title: "安装",
    kind: "document_mirror",
    sections: SAMPLE_SECTIONS,
    compiler: "gemma_knowledge_v3",
    complete: async () => sampleKnowledgeJson(),
  });
  assert.equal(result.pack.batches.length, 1);
  assert.equal(result.compiled.knowledge.claims[0]?.sourceChunkIds[0], "c1");
  assert.equal(result.diagnostics.claimCount, 1);
});

test("runCompileOutlinesJob: 有切片才重抽，空切片跳过", async () => {
  const { runCompileOutlinesJob } = await import(
    "../../services/knowledge/wiki/run-compile-outlines.ts"
  );
  const compiled: string[] = [];
  const result = await runCompileOutlinesJob({
    fetchLibraryDocuments: async () => [
      { id: "doc-a", name: "A.md" },
      { id: "doc-b", name: "B.md" },
    ],
    fetchChunks: async ({ documentId }) =>
      documentId === "doc-a"
        ? [
            {
              id: "c1",
              content: "# 安装\n简介。",
              pageNumber: 1,
              headingPath: ["安装"],
            },
          ]
        : [],
    compileMirror: async (input) => {
      compiled.push(input.documentId);
      return {
        id: `mirror:library:${input.documentId}`,
        slug: `mirror:library:${input.documentId}`,
        title: input.title,
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: input.documentId,
        markdown: "",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
      };
    },
    recordBuild: async () => true,
  });
  assert.deepEqual(compiled, ["doc-a"]);
  assert.equal(result.pageCount, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedOverCap, 0);
  assert.equal(result.compiler, "heading_extract_v1");
});

test("runCompileOutlinesJob: 超过 500 篇只扫硬顶", async () => {
  const { runCompileOutlinesJob } = await import(
    "../../services/knowledge/wiki/run-compile-outlines.ts"
  );
  const compiled: string[] = [];
  const docs = Array.from({ length: 501 }, (_, index) => ({
    id: `doc-${index + 1}`,
    name: `D${index + 1}.md`,
  }));
  const result = await runCompileOutlinesJob({
    fetchLibraryDocuments: async () => docs,
    fetchChunks: async () => [
      {
        id: "c1",
        content: "# 安装",
        pageNumber: 1,
        headingPath: ["安装"],
      },
    ],
    compileMirror: async (input) => {
      compiled.push(input.documentId);
      return {
        id: `mirror:library:${input.documentId}`,
        slug: `mirror:library:${input.documentId}`,
        title: input.title,
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: input.documentId,
        markdown: "",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
      };
    },
    recordBuild: async () => true,
  });
  assert.equal(compiled.length, 500);
  assert.equal(compiled[0], "doc-1");
  assert.equal(compiled[499], "doc-500");
  assert.equal(result.skippedOverCap, 1);
});

test("normalizeSettleTargets: 多目标优先于单文档字段", () => {
  const targets = normalizeSettleTargets({
    documentId: "doc-1",
    namespace: "library",
    targets: [
      { documentId: "doc-a", namespace: "library" },
      { documentId: "file-1", namespace: "conversation" },
    ],
  });
  assert.equal(targets.length, 2);
  assert.equal(targets[1]?.namespace, "conversation");
});

test("appendWikiNotes: 追加时间戳块，不重复同一正文", () => {
  const first = appendWikiNotes(undefined, "第一则", "2026-09-09T09:15:00.000Z");
  assert.match(first, /^## 对话沉淀/);
  assert.match(first, /第一则/);
  const second = appendWikiNotes(first, "第二则", "2026-09-09T10:00:00.000Z");
  assert.match(second, /第一则/);
  assert.match(second, /第二则/);
  assert.equal(appendWikiNotes(second, "第二则", "2026-09-09T11:00:00.000Z"), second);
  const long = appendWikiNotes(undefined, "很长的沉淀正文用于防误判", "2026-09-09T09:15:00.000Z");
  assert.match(
    appendWikiNotes(long, "沉淀", "2026-09-09T10:00:00.000Z"),
    /沉淀正文用于防误判/,
  );
});

test("settleWikiPages: 同一正文不重复写入，撤销仍指向已有标记", async () => {
  const existingId = "settle-existing";
  const notes = appendWikiNotes(
    undefined,
    "沉淀正文",
    "2026-09-09T09:15:00.000Z",
    existingId,
  );
  let patched = 0;
  const pages = await settleWikiPages({
    markdown: "沉淀正文",
    settleId: "settle-new",
    now: "2026-09-09T11:00:00.000Z",
    targets: [{ pageId: "p1", documentId: "doc-a", namespace: "library" }],
    fetchPageById: async () => ({
      id: "p1",
      slug: "p1",
      title: "手册",
      kind: "document_mirror",
      namespace: "library",
      sourceDocumentId: "doc-a",
      markdown: "md",
      sections: [],
      compiler: "heading_extract_v1",
      status: "ready",
      notesMarkdown: notes,
    }),
    patchPage: async () => {
      patched += 1;
      throw new Error("同一正文不应再 PATCH");
    },
  });
  assert.equal(patched, 0);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.settleId, existingId);
});

test("settleWikiPages: 写入全部引用文档，缺页的跳过", async () => {
  const patched: Array<{ pageId: string; notes?: string }> = [];
  const pages = await settleWikiPages({
    markdown: "沉淀正文",
    now: "2026-09-09T09:15:00.000Z",
    targets: [
      { documentId: "doc-a", namespace: "library" },
      { documentId: "missing", namespace: "library" },
      { documentId: "doc-b", namespace: "library" },
    ],
    fetchPageById: async () => null,
    loadMirror: async ({ documentId }) => {
      if (documentId === "missing") return null;
      return {
        id: `mirror:library:${documentId}`,
        slug: `mirror:library:${documentId}`,
        title: documentId,
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: documentId,
        markdown: "md",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
        synthesisMarkdown: "模型综述 [S1]",
      };
    },
    patchPage: async (pageId, patch) => {
      patched.push({ pageId, notes: patch.notesMarkdown });
      return {
        id: pageId,
        slug: pageId,
        title: pageId,
        kind: "document_mirror",
        namespace: "library",
        sourceDocumentId: pageId.replace("mirror:library:", ""),
        markdown: "md",
        sections: [],
        compiler: "heading_extract_v1",
        status: "ready",
        synthesisMarkdown: "模型综述 [S1]",
        notesMarkdown: patch.notesMarkdown,
        userEdited: false,
      };
    },
  });
  assert.deepEqual(
    patched.map((row) => row.pageId),
    ["mirror:library:doc-a", "mirror:library:doc-b"],
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.page.userEdited, false);
  assert.equal(pages[0]?.page.synthesisMarkdown, "模型综述 [S1]");
  assert.match(pages[0]?.page.notesMarkdown ?? "", /沉淀正文/);
  assert.equal(patched[0]?.notes?.includes("模型综述"), false);
});

test("wikiBrowseContextFromRequest: 默认 library:all，会话要带 fileId", () => {
  const library = wikiBrowseContextFromRequest(
    new Request("http://local/api/knowledge/wiki/pages/p1"),
  );
  assert.deepEqual(library.scope, { mode: "sources", library: "all" });
  const conversation = wikiBrowseContextFromRequest(
    new Request(
      "http://local/api/knowledge/wiki/pages/p1?conversationId=c1&fileId=f1",
    ),
  );
  assert.equal(conversation.conversationId, "c1");
  assert.equal(conversation.scope.mode, "sources");
  if (conversation.scope.mode === "sources") {
    assert.equal(conversation.scope.library, "all");
    assert.deepEqual(conversation.scope.conversationFiles, {
      conversationId: "c1",
      fileIds: ["f1"],
    });
  }
  const spoofed = wikiBrowseContextFromRequest(
    new Request(
      'http://local/api/knowledge/wiki/pages/p1?scope={"mode":"sources","library":"all","conversationFiles":{"conversationId":"x","fileIds":["y"]}}',
    ),
  );
  assert.deepEqual(spoofed.scope, { mode: "sources", library: "all" });
});

test("loadWikiHitsForQuery: FTS 种子后跟链并标记 followed", async () => {
  const original = globalThis.fetch;
  const seed = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-a",
    title: "手册 A.md",
    chunks: [
      {
        id: "a1",
        pageNumber: 1,
        headingPath: ["安装"],
        content: "# 安装\nA 的步骤。",
      },
    ],
  });
  const neighbor = {
    ...seed,
    id: "concept:library:install",
    slug: "concept:library:install",
    title: "安装",
    kind: "concept" as const,
    sourceDocumentId: "concept:install",
    sections: seed.sections.map((section) => ({
      ...section,
      sourceDocumentId: "doc-a",
      sourceDocumentTitle: "手册 A.md",
    })),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/wiki/pages?") && url.includes("q=")) {
      return new Response(JSON.stringify({ pages: [seed] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/links")) {
      return new Response(
        JSON.stringify({
          outgoing: [
            {
              fromId: seed.id,
              toId: neighbor.id,
              rel: "cites",
            },
          ],
          incoming: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(encodeURIComponent(neighbor.id)) || url.includes(neighbor.id)) {
      return new Response(JSON.stringify({ page: neighbor }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ page: seed }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const loaded = await loadWikiHitsForQuery(
      "安装",
      { mode: "sources", library: { documentIds: ["doc-a"] } },
      8,
      { actor: { kind: "local-user", id: "local" } },
    );
    assert.ok(loaded);
    assert.equal(loaded?.followed, true);
    assert.ok((loaded?.hits.length ?? 0) > 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadWikiHitsForQuery overview: 有内容词也只返回综述/对话沉淀", async () => {
  const original = globalThis.fetch;
  const page = {
    ...compileDocumentMirror({
      namespace: "library",
      documentId: "doc-1",
      title: "手册.md",
      chunks: [
        {
          id: "c1",
          pageNumber: 1,
          headingPath: ["安装"],
          content: "# 安装\nbrew 安装步骤。",
        },
      ],
    }),
    synthesisMarkdown: "这篇资料讲安装步骤。",
    notesMarkdown: "对话沉淀：安装时注意权限。",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/wiki/pages")) {
      return new Response(JSON.stringify({ pages: [page] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const loaded = await loadWikiHitsForQuery(
      "安装",
      { mode: "sources", library: { documentIds: ["doc-1"] } },
      8,
      { actor: { kind: "local-user", id: "local" } },
      { mode: "overview" },
    );
    assert.ok(loaded);
    assert.equal(loaded?.followed, false);
    assert.ok((loaded?.hits.length ?? 0) > 0);
    for (const hit of loaded?.hits ?? []) {
      const heading = hit.headingPath?.[0];
      assert.ok(heading === "综述" || heading === "对话沉淀");
      assert.equal(hit.content.startsWith("##"), false);
    }
    const headings = new Set(
      (loaded?.hits ?? []).map((hit) => hit.headingPath?.[0]),
    );
    assert.ok(headings.has("综述"));
    assert.ok(headings.has("对话沉淀"));
  } finally {
    globalThis.fetch = original;
  }
});

test("saveWikiCandidate: HTTP 失败抛 WikiPersistError", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("no", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        saveWikiCandidate({
          id: "cand-1",
          pageId: "mirror:library:doc-1",
          kind: "pending_merge",
          text: "待审核",
        }),
      (error: unknown) =>
        error instanceof WikiPersistError && error.op === "save_candidate",
    );
  } finally {
    globalThis.fetch = original;
  }
});

const MIRROR_CHUNKS = [
  {
    id: "c1",
    content: "# 安装\n先连接电源。",
    pageNumber: 1,
    headingPath: ["安装"],
  },
];

test("compileAndUpsertDocumentMirror: 普通摄取只维护 mirror，不自动排队 Gemma", async () => {
  const enqueued: Array<{ documentId: string; pageId?: string }> = [];
  const page = await compileAndUpsertDocumentMirror(
    {
      namespace: "library",
      documentId: "doc-1",
      title: "手册.md",
      chunks: MIRROR_CHUNKS,
    },
    {
      fetchExisting: async () => null,
      upsertPage: async (next) => next,
      markSourceUpdated: async () => 0,
      enqueueCompileWiki: async (input) => {
        enqueued.push({ documentId: input.documentId, pageId: input.pageId });
        return { jobId: "job-1", status: "queued" };
      },
    },
  );
  assert.ok(page);
  assert.equal(enqueued.length, 0);
});

test("compileAndUpsertDocumentMirror: 仅显式请求时排队 compile_wiki", async () => {
  let called = 0;
  await compileAndUpsertDocumentMirror(
    {
      namespace: "library",
      documentId: "doc-1",
      title: "手册.md",
      chunks: MIRROR_CHUNKS,
    },
    {
      enqueueKnowledge: true,
      fetchExisting: async () => null,
      upsertPage: async (next) => next,
      markSourceUpdated: async () => 0,
      enqueueCompileWiki: async () => {
        called += 1;
        return { jobId: "job-1", status: "queued" };
      },
    },
  );
  assert.equal(called, 1);
});

test("compileAndUpsertDocumentMirror: 人改页与入队失败都不阻断摄取", async () => {
  let called = 0;
  const existing = compileDocumentMirror({
    namespace: "library",
    documentId: "doc-1",
    title: "手册.md",
    chunks: MIRROR_CHUNKS,
  });
  existing.userEdited = true;
  const edited = await compileAndUpsertDocumentMirror(
    {
      namespace: "library",
      documentId: "doc-1",
      title: "手册.md",
      chunks: MIRROR_CHUNKS,
    },
    {
      enqueueKnowledge: true,
      fetchExisting: async () => existing,
      upsertPage: async (next) => next,
      markSourceUpdated: async () => 0,
      enqueueCompileWiki: async () => {
        called += 1;
        return { jobId: "job-1", status: "queued" };
      },
    },
  );
  assert.ok(edited);
  assert.equal(called, 0);

  const stored = await compileAndUpsertDocumentMirror(
    {
      namespace: "library",
      documentId: "doc-1",
      title: "手册.md",
      chunks: MIRROR_CHUNKS,
    },
    {
      enqueueKnowledge: true,
      fetchExisting: async () => null,
      upsertPage: async (next) => next,
      markSourceUpdated: async () => 0,
      enqueueCompileWiki: async () => {
        throw new Error("data-service busy");
      },
    },
  );
  assert.ok(stored);
});

test("parseWikiCompileForce: 人手改必须带 confirmForce", () => {
  assert.deepEqual(parseWikiCompileForce({ force: true, confirmForce: true }), {
    force: true,
    confirmForce: true,
  });
  assert.deepEqual(parseWikiCompileForce({ force: 1 }), {
    force: false,
    confirmForce: false,
  });
  assert.equal(wikiForceBlocked({ userEdited: true }, true, false), true);
  assert.equal(wikiForceBlocked({ userEdited: true }, true, true), false);
  assert.equal(wikiForceBlocked({ userEdited: true }, false, false), false);
  assert.equal(wikiForceBlocked({ userEdited: false }, true, false), false);
});
