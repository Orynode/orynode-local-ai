#!/usr/bin/env node
/**
 * 假 OCR helper：逐行读 stdin JSONL，立即写 stdout（保持 stdin 打开）
 * 用于验证 Node HelperSession 不会因等 EOF 而超时。
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = String(line || "").trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        ok: false,
        code: "OCR_HELPER_PROTOCOL_ERROR",
        message: "invalid json",
      })}\n`,
    );
    continue;
  }
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      requestId: req.requestId,
      pageNumber: req.pageNumber,
      ok: true,
      blocks: [
        {
          text: `mock-page-${req.pageNumber}`,
          bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
          confidence: 0.9,
          readingOrder: 0,
          language: "en-US",
        },
      ],
      engine: "mock-helper",
      engineVersion: "test",
      warnings: [],
    })}\n`,
  );
}
