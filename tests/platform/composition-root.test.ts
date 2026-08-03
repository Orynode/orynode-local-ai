import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeServices,
  resetRuntimeServicesForTests,
} from "../../services/platform/composition-root";
import { ModelCapabilityError } from "../../services/platform/windows/model-runtime";

test("createRuntimeServices: macOS 提供 modelRuntime", async () => {
  resetRuntimeServicesForTests();
  const prev = process.env.ORYNODE_HOST_PLATFORM;
  process.env.ORYNODE_HOST_PLATFORM = "macos";
  try {
    const runtime = createRuntimeServices({ projectRoot: process.cwd() });
    assert.equal(runtime.host.platform, "macos");
    assert.equal(typeof runtime.model.chat, "function");
    assert.equal(typeof runtime.model.listModels, "function");
    const caps = await runtime.host.capabilities();
    assert.equal(caps.modelRuntime, true);
  } finally {
    if (prev === undefined) delete process.env.ORYNODE_HOST_PLATFORM;
    else process.env.ORYNODE_HOST_PLATFORM = prev;
    resetRuntimeServicesForTests();
  }
});

test("createRuntimeServices: Windows stub 诚实不可用", async () => {
  resetRuntimeServicesForTests();
  const prev = process.env.ORYNODE_HOST_PLATFORM;
  process.env.ORYNODE_HOST_PLATFORM = "windows";
  try {
    const runtime = createRuntimeServices({ projectRoot: process.cwd() });
    assert.equal(runtime.host.platform, "windows");
    const health = await runtime.model.health();
    assert.equal(health.ok, false);
    assert.ok(runtime.ocr, "Windows OCR 预留 stub 应装配");
    const ocrCap = await runtime.ocr!.capabilities();
    assert.equal(ocrCap.available, false);
    assert.equal(ocrCap.engine, "pp-ocr-v5-mobile-onnx");
    await assert.rejects(
      () => runtime.model.chat([{ role: "user", content: "hi" }]),
      (error) =>
        error instanceof ModelCapabilityError &&
        error.code === "CAPABILITY_UNAVAILABLE",
    );
  } finally {
    if (prev === undefined) delete process.env.ORYNODE_HOST_PLATFORM;
    else process.env.ORYNODE_HOST_PLATFORM = prev;
    resetRuntimeServicesForTests();
  }
});
