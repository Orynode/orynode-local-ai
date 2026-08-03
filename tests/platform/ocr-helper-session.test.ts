/**
 * JSONL 会话：stdin 保持打开时逐页识别不得超时
 */

import assert from "node:assert/strict";
import { chmodSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAppleVisionOcrEngine } from "../../services/platform/macos/apple-vision-ocr";

const here = dirname(fileURLToPath(import.meta.url));
const mockHelper = resolve(here, "fixtures/mock-ocr-helper.mjs");

test("HelperSession: 保持 stdin 打开时可连续 recognize 两页", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orynode-ocr-sess-"));
  const png = join(dir, "p.png");
  // 最小合法 PNG 不是必须；mock helper 不读文件
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // 无扩展名可执行包装，避免部分环境无法直接 spawn .mjs
  const helperBin = join(dir, "orynode-ocr-mock");
  writeFileSync(
    helperBin,
    `#!/bin/bash\nexec node ${JSON.stringify(mockHelper)} "$@"\n`,
  );
  chmodSync(helperBin, 0o755);

  const engine = createAppleVisionOcrEngine({ helperPath: helperBin });

  await engine.beginSession();
  try {
    const a = await engine.recognizePage({
      pageNumber: 1,
      imageBytes: new Uint8Array([1]),
      mimeType: "image/png",
      width: 10,
      height: 10,
      recognitionLevel: "fast",
      imagePath: png,
    });
    const b = await engine.recognizePage({
      pageNumber: 2,
      imageBytes: new Uint8Array([1]),
      mimeType: "image/png",
      width: 10,
      height: 10,
      recognitionLevel: "fast",
      imagePath: png,
    });
    assert.equal(a.pageNumber, 1);
    assert.equal(b.pageNumber, 2);
    assert.match(a.text, /mock-page-1/);
    assert.match(b.text, /mock-page-2/);
  } finally {
    await engine.endSession();
    rmSync(dir, { recursive: true, force: true });
  }
});
