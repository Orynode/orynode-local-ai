/**
 * Windows OCR 预留 stub（KE-034）
 *
 * 不实现推理；诚实返回 OCR_UNAVAILABLE，并暴露规划中的 engine id / artifact 元数据。
 * 与 macOS 共用同一 OcrEngine 契约，供 capability / Fake contract 对齐。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OcrCapability, OcrEngine, OcrPageInput } from "../types";

export const WINDOWS_OCR_ENGINE_ID = "pp-ocr-v5-mobile-onnx";
export const WINDOWS_OCR_RESERVED_REASON = "OCR_UNAVAILABLE";

const ARTIFACT_REL =
  "artifacts/pp-ocr-v5-mobile-onnx.artifact.json";

export type WindowsOcrArtifactManifest = {
  status: "reserved";
  engineId: string;
  keTask: string;
  implementation: string;
  capabilityWhenMissing: string;
  artifacts: Record<string, unknown>;
  notes?: string[];
};

export function windowsOcrArtifactPath(projectRoot?: string): string {
  if (projectRoot) {
    return resolve(
      projectRoot,
      "services/platform/windows/artifacts/pp-ocr-v5-mobile-onnx.artifact.json",
    );
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, ARTIFACT_REL);
}

export function readWindowsOcrArtifactManifest(
  projectRoot?: string,
): WindowsOcrArtifactManifest {
  const raw = JSON.parse(
    readFileSync(windowsOcrArtifactPath(projectRoot), "utf8"),
  ) as WindowsOcrArtifactManifest;
  return raw;
}

/** 预留 stub：capabilities 标明 planned engine，recognizePage 恒失败 */
export function createWindowsOcrReservedStub(options?: {
  projectRoot?: string;
}): OcrEngine {
  const manifest = readWindowsOcrArtifactManifest(options?.projectRoot);
  const engineId = manifest.engineId || WINDOWS_OCR_ENGINE_ID;

  return {
    async capabilities(): Promise<OcrCapability> {
      return {
        available: false,
        engine: engineId,
        engineVersion: null,
        languages: [],
        boundingBoxes: true,
        reason: WINDOWS_OCR_RESERVED_REASON,
      };
    },

    async recognizePage(_input: OcrPageInput): Promise<never> {
      throw new Error(WINDOWS_OCR_RESERVED_REASON);
    },
  };
}
