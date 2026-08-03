/**
 * OCR Fake adapter — 契约测试与 Worker 注入
 */

import type {
  OcrCapability,
  OcrEngine,
  OcrPageInput,
  OcrPageResult,
} from "../types";
import { parseNormalizedBbox } from "./bbox";

export type FakeOcrOptions = {
  engine?: string;
  engineVersion?: string;
  available?: boolean;
  reason?: string;
  /** 按页返回固定结果；缺省用 input 生成一框占位 */
  pages?: Map<number, OcrPageResult>;
  delayMs?: number;
  failWith?: string;
};

export function createFakeOcrEngine(options: FakeOcrOptions = {}): OcrEngine {
  const engine = options.engine ?? "fake-ocr";
  const engineVersion = options.engineVersion ?? "test-1";
  const available = options.available !== false;
  let sessionOpen = false;

  return {
    async capabilities(): Promise<OcrCapability> {
      return {
        available,
        engine: available ? engine : null,
        engineVersion: available ? engineVersion : null,
        languages: available ? ["zh-Hans", "en-US"] : [],
        boundingBoxes: available,
        reason: available ? undefined : options.reason ?? "OCR_UNAVAILABLE",
      };
    },

    async beginSession() {
      sessionOpen = true;
    },

    async endSession() {
      sessionOpen = false;
    },

    async recognizePage(
      input: OcrPageInput,
      signal?: AbortSignal,
    ): Promise<OcrPageResult> {
      if (signal?.aborted) {
        throw new Error("OCR_CANCELLED");
      }
      if (!available) {
        throw new Error(options.reason ?? "OCR_UNAVAILABLE");
      }
      if (options.failWith) {
        throw new Error(options.failWith);
      }
      if (options.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, options.delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("OCR_CANCELLED"));
          });
        });
      }
      if (signal?.aborted) {
        throw new Error("OCR_CANCELLED");
      }

      const preset = options.pages?.get(input.pageNumber);
      if (preset) {
        return {
          ...preset,
          warnings: [
            ...(preset.warnings || []),
            sessionOpen ? "fake-session" : "fake-oneshot",
          ],
        };
      }

      const text = `fake-page-${input.pageNumber}`;
      const bbox = parseNormalizedBbox({
        x: 0.1,
        y: 0.1,
        width: 0.8,
        height: 0.05,
      });
      return {
        pageNumber: input.pageNumber,
        text,
        blocks: [
          {
            text,
            bbox,
            confidence: 0.99,
            readingOrder: 0,
            language: "en-US",
          },
        ],
        engine,
        engineVersion,
        warnings: [sessionOpen ? "fake-session" : "fake-oneshot"],
      };
    },
  };
}
