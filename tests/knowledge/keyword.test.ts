import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSearchTerms,
  extractTechnicalTerms,
  keywordScore,
  rrfFusion,
  weightedRrfFusion,
} from "../../services/knowledge/retrieval/keyword";

test("extractSearchTerms: 中英混合抽取", () => {
  const terms = extractSearchTerms("Orynode 本地知识库 retrieval");
  assert.ok(terms.includes("orynode"));
  assert.ok(terms.includes("retrieval"));
  assert.ok(terms.some((term) => term.includes("本地") || term === "本地"));
  assert.ok(terms.some((term) => term.includes("知识") || term === "知识"));
});

test("extractSearchTerms: 忽略过短 token", () => {
  const terms = extractSearchTerms("a I 的");
  assert.deepEqual(terms, []);
});

test("extractTechnicalTerms: 保留 C++ / C# / Node.js", () => {
  const terms = extractTechnicalTerms("用 C++ 和 C# 配置 Node.js access-token");
  assert.ok(terms.includes("c++"));
  assert.ok(terms.includes("c#"));
  assert.ok(terms.includes("node.js"));
  assert.ok(terms.includes("access-token"));
});

test("extractSearchTerms: 技术词进入查询词表", () => {
  const terms = extractSearchTerms("如何在 Node.js 里配置 C++ 插件");
  assert.ok(terms.includes("node.js"), `terms=${terms.join(",")}`);
  assert.ok(terms.includes("c++"), `terms=${terms.join(",")}`);
});

test("extractSearchTerms: 长中文问句核心词不被低信息 bigram 挤出", () => {
  const prefix =
    "请问一下如何怎么样才能正确地进行关于这个方面的一些问题解答也就是说";
  const core = "向量索引重建";
  const query = `${prefix}${core}`;
  const terms = extractSearchTerms(query, 20);
  assert.ok(
    terms.includes("向量") ||
      terms.includes("索引") ||
      terms.includes("重建") ||
      terms.includes(core) ||
      terms.some((t) => t.includes("向量") || t.includes("索引")),
    `core missing in terms=${terms.join(",")}`,
  );
  // 低信息词不应占满前部预算：至少应有非停用 bigram
  const lowInfoCount = terms.filter((t) =>
    ["如何", "怎么", "问题", "一下", "进行", "关于", "这个"].includes(t),
  ).length;
  assert.ok(lowInfoCount < terms.length, "不应几乎全是低信息词");
});

test("keywordScore: 按命中长度累计", () => {
  const score = keywordScore("本地知识库与本地检索", ["本地", "知识"]);
  assert.equal(score, 2 + 2 + 2); // 本地×2 + 知识×1
});

test("rrfFusion: 排名越前分越高", () => {
  const scores = rrfFusion([
    ["a", "b"],
    ["b", "c"],
  ]);
  assert.ok((scores.get("b") ?? 0) > (scores.get("a") ?? 0));
  assert.ok((scores.get("a") ?? 0) > (scores.get("c") ?? 0));
});

test("weightedRrfFusion: 高权重列表更有影响力", () => {
  const plain = rrfFusion([
    ["a", "b"],
    ["b", "a"],
  ]);
  const weighted = weightedRrfFusion(
    [
      ["a", "b"],
      ["b", "a"],
    ],
    [2.0, 0.5],
  );
  assert.ok((weighted.get("a") ?? 0) > (plain.get("a") ?? 0));
  assert.ok((weighted.get("a") ?? 0) > (weighted.get("b") ?? 0));
});
