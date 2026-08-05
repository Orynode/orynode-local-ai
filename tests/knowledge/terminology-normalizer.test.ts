import assert from "node:assert/strict";
import test from "node:test";
import { applyRewriteExcludes } from "../../services/knowledge/query/query-rewrite";
import {
  BUILTIN_TERMINOLOGY,
  TERMINOLOGY_VERSION,
} from "../../services/knowledge/query/terminology";
import { rewriteFromEntries } from "../../services/knowledge/query/terminology-match";
import {
  NORMALIZER_VERSION,
  hansHantVariants,
  buildMultilingualFields,
} from "../../services/knowledge/indexing/multilingual-normalizer";
import { planQuery } from "../../services/knowledge/query/planner";

test("terminology-v4-learned: 版本与小种子", () => {
  assert.equal(TERMINOLOGY_VERSION, "terminology-v4-learned");
  assert.ok(BUILTIN_TERMINOLOGY.some((e) => e.id === "reverse-proxy"));
  assert.ok(BUILTIN_TERMINOLOGY.some((e) => e.id === "sodium-ion-battery"));
});

test("rewriteFromEntries: access-token 组展开英文同义", () => {
  const rewrite = rewriteFromEntries(
    "访问令牌",
    BUILTIN_TERMINOLOGY,
    "terminology",
  );
  assert.equal(rewrite.source, "terminology");
  assert.ok(
    rewrite.synonyms.some((s) => /access/i.test(s)),
    `expected access synonym, got ${rewrite.synonyms.join(",")}`,
  );
  // 纯中文查询只保留非汉字同义（跨语言），简繁由 normalizer/高亮处理
  assert.equal(
    rewrite.synonyms.some((s) => /\p{Script=Han}/u.test(s)),
    false,
  );
});

test("rewriteFromEntries: reverse proxy → 反向代理 + exclude", () => {
  const rewrite = rewriteFromEntries(
    "reverse proxy",
    BUILTIN_TERMINOLOGY,
    "terminology",
  );
  assert.equal(rewrite.source, "terminology");
  assert.equal(rewrite.domain, "网络代理");
  assert.ok(rewrite.synonyms.includes("反向代理"));
  assert.ok(rewrite.exclude.includes("forward proxy"));
});

test("planQuery: 注入 rewrite 后每个同义短语独立 variant", () => {
  const rewrite = rewriteFromEntries(
    "reverse proxy",
    BUILTIN_TERMINOLOGY,
    "terminology",
  );
  const plan = planQuery("reverse proxy", { rewrite });
  assert.equal(plan.rewrite.source, "terminology");
  const expansions = plan.variants.filter((v) => v.kind === "term_expansion");
  assert.ok(expansions.length >= 1);
  assert.ok(
    expansions.some((v) => v.text === "反向代理" && v.phrase === "反向代理"),
  );
});

test("planQuery: 未注入 rewrite 时不自行查术语表", () => {
  const plan = planQuery("访问令牌");
  assert.equal(plan.rewrite.source, "none");
  assert.equal(
    plan.variants.filter((v) => v.kind === "term_expansion").length,
    0,
  );
});

test("applyRewriteExcludes: 仅排除无正例命中的段落", () => {
  const hits = [
    { id: "1", content: "配置 nginx reverse proxy 到上游" },
    { id: "2", content: "浏览器普通代理与 forward proxy 说明" },
    { id: "3", content: "无关的天气说明" },
  ];
  const filtered = applyRewriteExcludes(
    hits,
    ["reverse proxy", "反向代理"],
    ["forward proxy", "普通代理"],
  );
  assert.deepEqual(
    filtered.map((h) => h.id),
    ["1", "3"],
  );
});

test("applyRewriteExcludes: 拉丁词界，不因子串误杀", () => {
  const hits = [
    { id: "1", content: "This discusses approximation methods." },
    { id: "2", content: "Use a forward proxy for egress." },
  ];
  const filtered = applyRewriteExcludes(hits, ["reverse proxy"], ["proxy"]);
  assert.deepEqual(
    filtered.map((h) => h.id),
    ["1"],
  );
});

test("ml-normalizer-v2: 简繁变体与 zh_text", () => {
  assert.equal(NORMALIZER_VERSION, "ml-normalizer-v2");
  const variants = hansHantVariants("资料库");
  assert.ok(variants.includes("资料库"));
  assert.ok(variants.includes("資料庫"));

  const fields = buildMultilingualFields("配置访问令牌。");
  assert.equal(fields.normalizerVersion, "ml-normalizer-v2");
  assert.match(fields.zhText, /訪問令牌|访问令牌/);
});
