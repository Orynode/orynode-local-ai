#!/usr/bin/env node
/**
 * KE-033 OCR micro-bench 钩子
 *
 * - 默认用 Fake OCR，可重复、不依赖硬件，不写虚假真机结论
 * - ORYNODE_OCR_BENCH_REAL=1 且 helper 可用时跑真实 helper 单页探测（仍不编造 8/16GB 档位报告）
 *
 * 用法：npm run ocr:bench
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createFakeOcrEngine } from "../services/platform/ocr/fake-ocr.ts";
import {
  createAppleVisionOcrEngine,
  isOcrHelperExecutable,
  defaultOcrHelperPath,
} from "../services/platform/macos/apple-vision-ocr.ts";
import { OCR_CONFIG } from "../config/defaults.ts";

const projectRoot = resolve(process.env.ORYNODE_PROJECT_ROOT || process.cwd());
const outDir = resolve(projectRoot, ".orynode/benchmarks");
const real = process.env.ORYNODE_OCR_BENCH_REAL === "1";

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

async function benchFake() {
  const engine = createFakeOcrEngine({ delayMs: 2 });
  await engine.beginSession?.();
  const pages = 20;
  const t0 = performance.now();
  const rss0 = rssMb();
  try {
    for (let i = 1; i <= pages; i += 1) {
      await engine.recognizePage({
        pageNumber: i,
        imageBytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
        width: 100,
        height: 100,
        recognitionLevel: "fast",
      });
    }
  } finally {
    await engine.endSession?.();
  }
  const elapsedMs = Math.round(performance.now() - t0);
  return {
    mode: "fake",
    pages,
    elapsedMs,
    msPerPage: Math.round((elapsedMs / pages) * 10) / 10,
    rssStartMb: rss0,
    rssEndMb: rssMb(),
    sessionReuse: true,
    note: "Synthetic Fake OCR; not a hardware capability claim.",
  };
}

async function benchRealHelper() {
  const helper = defaultOcrHelperPath(projectRoot);
  if (!isOcrHelperExecutable(helper)) {
    return {
      mode: "real-helper",
      skipped: true,
      reason: "OCR helper not installed; run npm run ocr:install",
    };
  }
  const engine = createAppleVisionOcrEngine({ projectRoot, helperPath: helper });
  const cap = await engine.capabilities();
  if (!cap.available) {
    return {
      mode: "real-helper",
      skipped: true,
      reason: cap.reason || "OCR_UNAVAILABLE",
    };
  }

  // 最小 PNG（1x1）——只测 helper 会话开销，不声称识别质量
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "orynode-ocr-bench-"));
  // 最小合法 PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngPath = join(dir, "probe.png");
  await writeFile(pngPath, png);

  const pages = 5;
  const t0 = performance.now();
  const rss0 = rssMb();
  await engine.beginSession();
  try {
    for (let i = 1; i <= pages; i += 1) {
      await engine.recognizePage({
        pageNumber: i,
        imageBytes: new Uint8Array(png),
        mimeType: "image/png",
        width: 1,
        height: 1,
        recognitionLevel: "fast",
        imagePath: pngPath,
      });
    }
  } finally {
    await engine.endSession();
    await rm(dir, { recursive: true, force: true });
  }
  const elapsedMs = Math.round(performance.now() - t0);
  return {
    mode: "real-helper",
    skipped: false,
    engine: cap.engine,
    engineVersion: cap.engineVersion,
    pages,
    elapsedMs,
    msPerPage: Math.round((elapsedMs / pages) * 10) / 10,
    rssStartMb: rss0,
    rssEndMb: rssMb(),
    sessionReuse: true,
    ocrConfig: {
      renderDpi: OCR_CONFIG.renderDpi,
      maxOcrPagesPerDocument: OCR_CONFIG.maxOcrPagesPerDocument,
      ocrPageTimeoutMs: OCR_CONFIG.ocrPageTimeoutMs,
    },
    hardwareTiers: {
      "8gb": "not_measured",
      "16gb": "not_measured",
    },
    note: "Probe only; do not treat as KE-033 full quality/resource matrix. Set ORYNODE_OCR_BENCH_REAL=1 on target Macs to collect local numbers.",
  };
}

async function faultInjectionSmoke() {
  const unavailable = createFakeOcrEngine({ available: false });
  let unavailableOk = false;
  try {
    await unavailable.recognizePage({
      pageNumber: 1,
      imageBytes: new Uint8Array([1]),
      mimeType: "image/png",
      width: 1,
      height: 1,
      recognitionLevel: "fast",
    });
  } catch (error) {
    unavailableOk = String(error?.message || "").includes("OCR_UNAVAILABLE");
  }

  const timeoutish = createFakeOcrEngine({ failWith: "OCR_TIMEOUT" });
  let timeoutOk = false;
  try {
    await timeoutish.recognizePage({
      pageNumber: 1,
      imageBytes: new Uint8Array([1]),
      mimeType: "image/png",
      width: 1,
      height: 1,
      recognitionLevel: "fast",
    });
  } catch (error) {
    timeoutOk = String(error?.message || "").includes("OCR_TIMEOUT");
  }

  return { unavailableOk, timeoutOk };
}

const report = {
  version: 1,
  createdAt: new Date().toISOString(),
  host: process.platform,
  arch: process.arch,
  fake: await benchFake(),
  real: real ? await benchRealHelper() : { mode: "real-helper", skipped: true, reason: "ORYNODE_OCR_BENCH_REAL not set" },
  faultInjection: await faultInjectionSmoke(),
  disclaimer:
    "KE-033 micro-bench hook. Without explicit multi-device runs, hardware tier conclusions remain not_measured.",
};

mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `ocr-bench-${Date.now()}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
const latest = resolve(outDir, "ocr-bench-latest.json");
writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, outPath, latest, summary: {
  fakeMsPerPage: report.fake.msPerPage,
  realSkipped: report.real.skipped !== false,
  faultInjection: report.faultInjection,
} }, null, 2));

if (!report.faultInjection.unavailableOk || !report.faultInjection.timeoutOk) {
  process.exitCode = 1;
}
