/**
 * Platform composition root — 依赖装配唯一入口（KE-P3-01）
 *
 * Chat / Status / Agent 不得直接 import TurboFieldfare；只通过本模块拿 ModelRuntime / OcrEngine。
 */

import { resolve } from "node:path";
import type { HostRuntime, ModelRuntime, OcrEngine } from "./types";
import { createHostRuntime, detectHostPlatform } from "./factory";
import { createTurboFieldfareModelRuntime } from "./macos/model-runtime";
import {
  createAppleVisionOcrEngine,
  isOcrHelperExecutable,
  defaultOcrHelperPath,
} from "./macos/apple-vision-ocr";
import { createWindowsModelRuntimeStub } from "./windows/model-runtime";
import { createWindowsOcrReservedStub } from "./windows/ocr-reserved";

export type RuntimeServices = {
  host: HostRuntime;
  model: ModelRuntime;
  ocr: OcrEngine | null;
};

let cached: RuntimeServices | null = null;

function defaultProjectRoot(): string {
  return resolve(process.env.ORYNODE_PROJECT_ROOT || process.cwd());
}

function resolveOcr(
  platform: "macos" | "windows",
  projectRoot: string,
  forceOcr?: OcrEngine | null,
): OcrEngine | null {
  if (forceOcr !== undefined) return forceOcr ?? null;
  if (platform === "windows") {
    // KE-034：预留 stub，不实现推理；capability 诚实 OCR_UNAVAILABLE
    return createWindowsOcrReservedStub({ projectRoot });
  }
  const helper = defaultOcrHelperPath(projectRoot);
  if (!isOcrHelperExecutable(helper)) return null;
  return createAppleVisionOcrEngine({ projectRoot, helperPath: helper });
}

export function createRuntimeServices(options?: {
  projectRoot?: string;
  /** 测试注入；生产勿传 */
  force?: Partial<RuntimeServices>;
}): RuntimeServices {
  if (options?.force) {
    const host =
      options.force.host ??
      createHostRuntime(options.projectRoot ?? defaultProjectRoot());
    const platform = host.platform;
    const projectRoot = options.projectRoot ?? defaultProjectRoot();
    return {
      host,
      model:
        options.force.model ??
        (platform === "windows"
          ? createWindowsModelRuntimeStub()
          : createTurboFieldfareModelRuntime()),
      ocr: resolveOcr(platform, projectRoot, options.force.ocr),
    };
  }

  if (cached) return cached;

  const projectRoot = options?.projectRoot ?? defaultProjectRoot();
  const platform = detectHostPlatform();
  const host = createHostRuntime(projectRoot, platform);
  const model =
    platform === "windows"
      ? createWindowsModelRuntimeStub()
      : createTurboFieldfareModelRuntime();
  const ocr = resolveOcr(platform, projectRoot);

  cached = { host, model, ocr };
  return cached;
}

/** 测试用：清空单例 */
export function resetRuntimeServicesForTests(): void {
  cached = null;
}
