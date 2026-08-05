import assert from "node:assert/strict";
import test from "node:test";

/**
 * 与 useKnowledge.summarizeReindex 对齐的纯函数副本，避免拉客户端 hook。
 * 若 UI 摘要语义变更，请同步此处。
 */
function summarizeReindex(
  results: Array<{ id: string; status: string; reason?: string }>,
): { text: string; isError: boolean } {
  if (results.length === 0) {
    return { text: "没有可索引的文档", isError: false };
  }
  const queued = results.filter((item) => item.status === "queued");
  const skipped = results.filter((item) => item.status === "skipped");
  const indexed = results.filter((item) => item.status === "indexed");
  const errors = results.filter((item) => item.status === "error");

  if (queued.length === results.length) {
    return {
      text: `已入队后台重建 ${queued.length} 篇（可继续关键词检索）`,
      isError: false,
    };
  }
  if (skipped.length === results.length) {
    return {
      text: skipped[0]?.reason || "已跳过索引",
      isError: true,
    };
  }
  if (errors.length > 0 && indexed.length === 0 && queued.length === 0) {
    return { text: `索引失败 ${errors.length} 篇`, isError: true };
  }
  if (indexed.length === results.length) {
    return { text: `已更新 ${indexed.length} 篇索引`, isError: false };
  }
  return {
    text:
      (queued.length ? `已入队 ${queued.length} 篇` : "") +
      (indexed.length
        ? `${queued.length ? "，" : ""}已更新 ${indexed.length} 篇`
        : "") +
      (errors.length ? `，失败 ${errors.length}` : "") +
      (skipped.length ? `，跳过 ${skipped.length}` : ""),
    isError: errors.length > 0,
  };
}

test("重建索引入队不应当成错误提示", () => {
  const summary = summarizeReindex([
    { id: "a", status: "queued", reason: "已入队后台向量重建" },
    { id: "b", status: "queued" },
  ]);
  assert.equal(summary.isError, false);
  assert.match(summary.text, /入队/);
});

test("真正跳过（未开语义）仍为错误提示", () => {
  const summary = summarizeReindex([
    {
      id: "a",
      status: "skipped",
      reason: "主机未加载向量模型",
    },
  ]);
  assert.equal(summary.isError, true);
});
