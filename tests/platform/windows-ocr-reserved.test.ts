/**
 * Windows OCR 预留 stub + artifact metadata（KE-034）
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createWindowsOcrReservedStub,
  readWindowsOcrArtifactManifest,
  WINDOWS_OCR_ENGINE_ID,
  WINDOWS_OCR_RESERVED_REASON,
} from "../../services/platform/windows/ocr-reserved";
import { createRuntimeServices, resetRuntimeServicesForTests } from "../../services/platform/composition-root";
import { createWindowsHostRuntime } from "../../services/platform/windows/index";
import { createWindowsModelRuntimeStub } from "../../services/platform/windows/model-runtime";

test("Windows OCR artifact manifest 标记 reserved", () => {
  const manifest = readWindowsOcrArtifactManifest();
  assert.equal(manifest.status, "reserved");
  assert.equal(manifest.engineId, WINDOWS_OCR_ENGINE_ID);
  assert.equal(manifest.keTask, "KE-034");
  assert.equal(manifest.implementation, "not_started");
  assert.ok(manifest.artifacts.detector);
  assert.ok(manifest.artifacts.recognizer);
  assert.ok(manifest.artifacts.dictionary);
  assert.ok(manifest.artifacts.runtime);
});

test("Windows OCR reserved stub: capabilities 诚实不可用", async () => {
  const engine = createWindowsOcrReservedStub();
  const cap = await engine.capabilities();
  assert.equal(cap.available, false);
  assert.equal(cap.engine, WINDOWS_OCR_ENGINE_ID);
  assert.equal(cap.reason, WINDOWS_OCR_RESERVED_REASON);
  await assert.rejects(
    () =>
      engine.recognizePage({
        pageNumber: 1,
        imageBytes: new Uint8Array([1]),
        mimeType: "image/png",
        width: 1,
        height: 1,
        recognitionLevel: "fast",
      }),
    /OCR_UNAVAILABLE/,
  );
});

test("composition-root Windows 装配预留 OCR stub（非 null）", async () => {
  resetRuntimeServicesForTests();
  const runtime = createRuntimeServices({
    force: {
      host: createWindowsHostRuntime("/tmp/orynode-win-test"),
      model: createWindowsModelRuntimeStub(),
    },
  });
  assert.ok(runtime.ocr);
  const cap = await runtime.ocr!.capabilities();
  assert.equal(cap.available, false);
  assert.equal(cap.engine, WINDOWS_OCR_ENGINE_ID);
  const hostCap = await runtime.host.capabilities();
  assert.equal(hostCap.ocr, false);
  resetRuntimeServicesForTests();
});
