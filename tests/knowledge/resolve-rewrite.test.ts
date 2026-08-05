import assert from "node:assert/strict";
import test from "node:test";
import { resolveQueryRewrite } from "../../services/knowledge/query/resolve-rewrite";

test("resolveQueryRewrite: 术语库命中不调 LLM", async () => {
  let llmCalls = 0;
  const rewrite = await resolveQueryRewrite("反向代理", {
    learnedEntries: [
      {
        id: "learned-1",
        domain: "网络代理",
        terms: ["反向代理", "reverse proxy"],
        exclude: ["forward proxy"],
      },
    ],
    llmRewrite: async () => {
      llmCalls += 1;
      return { synonyms: ["should-not-run"], exclude: [] };
    },
  });
  assert.equal(rewrite.source, "terminology");
  assert.ok(rewrite.synonyms.includes("reverse proxy"));
  assert.equal(llmCalls, 0);
});

test("resolveQueryRewrite: 未命中则 LLM 并标记 source=llm", async () => {
  let llmCalls = 0;
  const rewrite = await resolveQueryRewrite("固态电解质界面", {
    learnedEntries: [],
    skipLlm: false,
    llmRewrite: async () => {
      llmCalls += 1;
      return {
        domain: "电池",
        synonyms: ["SEI", "solid electrolyte interphase"],
        exclude: ["电解液"],
      };
    },
  });
  assert.equal(llmCalls, 1);
  assert.equal(rewrite.source, "llm");
  assert.ok(rewrite.synonyms.some((s) => /SEI|solid electrolyte/i.test(s)));
});

test("resolveQueryRewrite: skipLlm 时未命中不调用", async () => {
  let llmCalls = 0;
  const rewrite = await resolveQueryRewrite("完全未登录词xyz", {
    learnedEntries: [],
    skipLlm: true,
    llmRewrite: async () => {
      llmCalls += 1;
      return { synonyms: ["x"], exclude: [] };
    },
  });
  assert.equal(llmCalls, 0);
  assert.equal(rewrite.source, "none");
});
