import assert from "node:assert/strict";
import test from "node:test";
import {
  documentViewStatus,
  isUsableLibraryDocument,
} from "../../services/knowledge/status";

test("documentViewStatus: OCR 页数超限为不可用且不建议重试", () => {
  const status = documentViewStatus(
    {
      status: "processing_error",
      chunkCount: 0,
      errorMessage: "OCR_PAGE_LIMIT_EXCEEDED",
    },
    true,
  );

  assert.equal(status.content, "unavailable");
  assert.equal(status.fitness, "unsuitable");
  assert.equal(status.severity, "danger");
  assert.equal(status.canAttach, false);
  assert.equal(status.canRetryProcessing, false);
  assert.match(status.detail, /拆分 PDF/);
});

test("documentViewStatus: OCR 截断成功仍可挂对话（降级提示）", () => {
  const status = documentViewStatus(
    {
      status: "ready",
      chunkCount: 40,
      errorMessage: "OCR_PAGE_TRUNCATED:100/833",
    },
    false,
  );

  assert.equal(status.content, "usable");
  assert.equal(status.fitness, "degraded");
  assert.equal(status.canAttach, true);
  assert.equal(status.severity, "warning");
  assert.match(status.detail, /前 100 页/);
  assert.match(status.detail, /833/);
});

test("documentViewStatus: OCR 超时为可重试处理失败", () => {
  const status = documentViewStatus(
    {
      status: "processing_error",
      chunkCount: 0,
      errorMessage: "OCR_TIMEOUT",
    },
    true,
  );

  assert.equal(status.fitness, "retryable");
  assert.equal(status.canRetryProcessing, true);
});

test("documentViewStatus: OCR_DISABLED 不可重试", () => {
  const status = documentViewStatus(
    {
      status: "processing_error",
      chunkCount: 0,
      errorMessage: "OCR_DISABLED",
    },
    true,
  );

  assert.equal(status.fitness, "unsuitable");
  assert.equal(status.canRetryProcessing, false);
  assert.match(status.detail, /开启 OCR/);
});

test("documentViewStatus: processing_error 即使有旧 chunks 也不可挂对话（对齐 FTS）", () => {
  const status = documentViewStatus(
    {
      status: "processing_error",
      chunkCount: 12,
      errorMessage: "OCR_TIMEOUT",
    },
    true,
  );

  assert.equal(status.content, "unavailable");
  assert.equal(status.canAttach, false);
  assert.equal(isUsableLibraryDocument({ status: "processing_error", chunkCount: 12 }), false);
  assert.match(status.label, /暂不可检索/);
});

test("documentViewStatus: processing 中即使有旧 chunks 也不可挂对话", () => {
  const status = documentViewStatus(
    {
      status: "processing",
      chunkCount: 12,
      errorMessage: null,
    },
    true,
  );

  assert.equal(status.content, "processing");
  assert.equal(status.canAttach, false);
  assert.match(status.label, /暂不可检索/);
});

test("documentViewStatus: 向量失败不抹掉关键词可用能力", () => {
  const status = documentViewStatus(
    {
      status: "error",
      chunkCount: 12,
      errorMessage: "embedding failed",
    },
    true,
  );

  assert.equal(status.content, "usable");
  assert.equal(status.semantic, "failed");
  assert.equal(status.fitness, "degraded");
  assert.equal(status.canAttach, true);
  assert.equal(isUsableLibraryDocument({ status: "error", chunkCount: 12 }), true);
  assert.match(status.label, /关键词可用/);
});

test("documentViewStatus: indexed 是关键词与语义均就绪", () => {
  const status = documentViewStatus(
    {
      status: "indexed",
      chunkCount: 12,
      errorMessage: null,
    },
    true,
  );

  assert.equal(status.content, "usable");
  assert.equal(status.semantic, "ready");
  assert.equal(status.fitness, "ok");
});
