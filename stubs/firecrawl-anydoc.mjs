/**
 * Stub for @firecrawl/anydoc under vinext/Workers.
 * 真实转换只在 data-service（Node）运行；Workers 不得加载原生 .node。
 * toDocument 仅满足类型/别名形状；生产摄取禁止调用（会物化嵌入图 bytes）。
 */

export function toMarkdownBytes() {
  return Promise.reject(
    new Error("@firecrawl/anydoc is unavailable in the vinext Workers runtime"),
  );
}

export function toDocument() {
  return Promise.reject(
    new Error("@firecrawl/anydoc is unavailable in the vinext Workers runtime"),
  );
}

export function formatFromBytes() {
  return null;
}

export function formatFromExtension() {
  return null;
}

const anydocStub = {
  toMarkdownBytes,
  toDocument,
  formatFromBytes,
  formatFromExtension,
};

export default anydocStub;
