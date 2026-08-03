/**
 * macOS Apple Vision OCR adapter — 通过 Swift CLI helper 逐页识别
 *
 * 文档级会话：beginSession 启动长驻 helper，recognizePage 走 JSONL 复用进程，
 * endSession 关闭。未开会话时仍可单次 spawn（兼容探测路径）。
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { OCR_CONFIG } from "../../../config/defaults";
import type {
  OcrCapability,
  OcrEngine,
  OcrPageInput,
  OcrPageResult,
} from "../types";
import {
  OCR_HELPER_PROTOCOL_VERSION,
  parseHelperResponseLine,
  type OcrHelperRequest,
} from "./ocr-helper-protocol";

export function defaultOcrHelperPath(projectRoot: string): string {
  const fromEnv = process.env.ORYNODE_OCR_HELPER;
  if (fromEnv) return fromEnv;
  const installed = resolve(projectRoot, ".orynode/bin/orynode-ocr");
  if (existsSync(installed)) return installed;
  return resolve(
    projectRoot,
    "native/macos/orynode-ocr/.build/release/orynode-ocr",
  );
}

export function isOcrHelperExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runHelperOnce(
  helperPath: string,
  args: string[],
  stdinLine: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("OCR_CANCELLED");

  return new Promise((resolvePromise, reject) => {
    const child = spawn(helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(new Error("OCR_TIMEOUT"));
    }, timeoutMs);

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(new Error("OCR_CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(err?: Error, value?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolvePromise(value ?? "");
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2000) stderr = stderr.slice(0, 2000);
    });
    child.on("error", (error) => {
      finish(new Error(`OCR_UNAVAILABLE:${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        finish(new Error("OCR_HELPER_PROTOCOL_ERROR"));
        return;
      }
      finish(undefined, stdout);
    });

    if (stdinLine != null) {
      child.stdin.write(`${stdinLine}\n`);
    }
    child.stdin.end();
  });
}

class HelperSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;

  constructor(
    private readonly helperPath: string,
    private readonly timeoutMs: number,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    if (!isOcrHelperExecutable(this.helperPath)) {
      throw new Error("OCR_UNAVAILABLE");
    }
    this.closed = false;
    this.child = spawn(this.helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drainLines();
    });
    this.child.stderr.on("data", () => {
      // 不记录正文/路径
    });
    this.child.on("error", (error) => {
      this.failAll(new Error(`OCR_UNAVAILABLE:${error.message}`));
    });
    this.child.on("close", () => {
      this.child = null;
      this.failAll(new Error("OCR_HELPER_PROTOCOL_ERROR"));
    });
  }

  private drainLines() {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
    }
  }

  private failAll(err: Error) {
    const pending = this.waiters.splice(0);
    for (const w of pending) w.reject(err);
  }

  async request(stdinLine: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !this.child) {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    if (signal?.aborted) throw new Error("OCR_CANCELLED");

    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          // ignore
        }
        cleanup();
        reject(new Error("OCR_TIMEOUT"));
      }, this.timeoutMs);

      const onAbort = () => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          // ignore
        }
        cleanup();
        reject(new Error("OCR_CANCELLED"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      signal?.addEventListener("abort", onAbort, { once: true });

      this.waiters.push({
        resolve: (line) => {
          cleanup();
          resolvePromise(line);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      try {
        this.child!.stdin.write(`${stdinLine}\n`);
      } catch (error) {
        cleanup();
        reject(
          error instanceof Error
            ? error
            : new Error("OCR_HELPER_PROTOCOL_ERROR"),
        );
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("OCR_CANCELLED"));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

export async function probeAppleVisionOcrCapability(
  projectRoot: string,
): Promise<OcrCapability> {
  const helperPath = defaultOcrHelperPath(projectRoot);
  if (!isOcrHelperExecutable(helperPath)) {
    return {
      available: false,
      engine: null,
      engineVersion: null,
      languages: [],
      boundingBoxes: false,
      reason: "OCR_UNAVAILABLE",
    };
  }
  try {
    const out = await runHelperOnce(
      helperPath,
      ["--capabilities"],
      null,
      8_000,
    );
    const line = out.trim().split("\n").filter(Boolean).pop();
    if (!line) {
      return {
        available: false,
        engine: null,
        engineVersion: null,
        languages: [],
        boundingBoxes: false,
        reason: "OCR_HELPER_PROTOCOL_ERROR",
      };
    }
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.protocolVersion !== OCR_HELPER_PROTOCOL_VERSION || raw.ok !== true) {
      return {
        available: false,
        engine: null,
        engineVersion: null,
        languages: [],
        boundingBoxes: false,
        reason: "OCR_HELPER_PROTOCOL_ERROR",
      };
    }
    const available = raw.available === true;
    return {
      available,
      engine: available && typeof raw.engine === "string" ? raw.engine : null,
      engineVersion:
        available && typeof raw.engineVersion === "string"
          ? raw.engineVersion
          : null,
      languages: Array.isArray(raw.languages)
        ? raw.languages.filter((x): x is string => typeof x === "string")
        : [],
      boundingBoxes: raw.boundingBoxes === true,
      reason: available ? undefined : "OCR_UNAVAILABLE",
    };
  } catch {
    return {
      available: false,
      engine: null,
      engineVersion: null,
      languages: [],
      boundingBoxes: false,
      reason: "OCR_UNAVAILABLE",
    };
  }
}

export type AppleVisionOcrEngine = OcrEngine & {
  beginSession(): Promise<void>;
  endSession(): Promise<void>;
};

export function createAppleVisionOcrEngine(options?: {
  projectRoot?: string;
  helperPath?: string;
}): AppleVisionOcrEngine {
  const projectRoot = options?.projectRoot ?? process.cwd();
  const helperPath = options?.helperPath ?? defaultOcrHelperPath(projectRoot);
  let session: HelperSession | null = null;

  async function recognizeWithPayload(
    input: OcrPageInput,
    signal?: AbortSignal,
  ): Promise<OcrPageResult> {
    if (!isOcrHelperExecutable(helperPath)) {
      throw new Error("OCR_UNAVAILABLE");
    }
    if (signal?.aborted) throw new Error("OCR_CANCELLED");

    let imagePath: string | null = null;
    let owned = false;
    const maybePath = input.imagePath;
    try {
      if (typeof maybePath === "string" && maybePath) {
        imagePath = maybePath;
      } else {
        const { writeFile, mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "orynode-ocr-in-"));
        imagePath = join(dir, `page-${input.pageNumber}.png`);
        await writeFile(imagePath, Buffer.from(input.imageBytes));
        owned = true;
      }

      const requestId = randomUUID();
      const payload: OcrHelperRequest = {
        protocolVersion: OCR_HELPER_PROTOCOL_VERSION,
        requestId,
        pageNumber: input.pageNumber,
        imagePath,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        languages: input.languages,
        recognitionLevel: input.recognitionLevel,
      };
      const linePayload = JSON.stringify(payload);

      let line: string;
      if (session) {
        line = await session.request(linePayload, signal);
      } else {
        const out = await runHelperOnce(
          helperPath,
          [],
          linePayload,
          OCR_CONFIG.ocrPageTimeoutMs,
          signal,
        );
        const last = out.trim().split("\n").filter(Boolean).pop();
        if (!last) throw new Error("OCR_HELPER_PROTOCOL_ERROR");
        line = last;
      }

      return parseHelperResponseLine(line, {
        requestId,
        pageNumber: input.pageNumber,
      });
    } finally {
      if (owned && imagePath) {
        const dir = resolve(imagePath, "..");
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  return {
    async capabilities(): Promise<OcrCapability> {
      return probeAppleVisionOcrCapability(projectRoot);
    },

    async beginSession(): Promise<void> {
      if (session) return;
      session = new HelperSession(helperPath, OCR_CONFIG.ocrPageTimeoutMs);
      await session.start();
    },

    async endSession(): Promise<void> {
      const current = session;
      session = null;
      if (current) await current.close();
    },

    async recognizePage(
      input: OcrPageInput,
      signal?: AbortSignal,
    ): Promise<OcrPageResult> {
      return recognizeWithPayload(input, signal);
    },
  };
}
