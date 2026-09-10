import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFtsMatchQuery,
  buildSearchText,
  contextualizeChunkText,
  escapeFtsToken,
} from "../../services/knowledge/retrieval/search-text";

test("buildSearchText: 保留正文并附加中文 bigram", () => {
  const text = buildSearchText("Orynode 知识引擎");
  assert.match(text, /orynode 知识引擎/);
  assert.match(text, /知识/);
  assert.match(text, /引擎/);
});

test("buildSearchText: 附加技术标识整词", () => {
  const text = buildSearchText("Install Node.js and enable C++ addon");
  assert.match(text, /node\.js/);
  assert.match(text, /c\+\+/);
});

test("buildSearchText: 标题栈进入索引正文", () => {
  const text = buildSearchText("先连接电源再打开开关。", ["部署", "安装"]);
  assert.match(text, /部署 \/ 安装/);
  assert.match(text, /安装/);
  assert.match(text, /先连接电源再打开开关/);
});

test("contextualizeChunkText: 正文已带末级标题则不重复前缀", () => {
  assert.equal(
    contextualizeChunkText("# 安装\n步骤", ["安装"]),
    "# 安装\n步骤",
  );
});

test("escapeFtsToken / buildFtsMatchQuery", () => {
  assert.equal(escapeFtsToken('a"b'), `"a""b"`);
  assert.equal(buildFtsMatchQuery(["知识", "engine"]), `"知识" AND "engine"`);
  assert.equal(
    buildFtsMatchQuery(["知识", "engine"], { operator: "OR" }),
    `"知识" OR "engine"`,
  );
  assert.equal(buildFtsMatchQuery([]), null);
});
