/**
 * HostRuntime 工厂 — Chat/RAG 不感知具体 OS 细节
 */

import type { HostPlatform, HostRuntime } from "./types";
import { createMacosHostRuntime } from "./macos/index";
import { createWindowsHostRuntime } from "./windows/index";

export function detectHostPlatform(): HostPlatform {
  const forced = process.env.ORYNODE_HOST_PLATFORM;
  if (forced === "windows" || forced === "macos") return forced;
  // 不在 knowledge core 使用 process.platform；仅 Host factory 允许
  return process.platform === "win32" ? "windows" : "macos";
}

export function createHostRuntime(
  projectRoot: string,
  platform: HostPlatform = detectHostPlatform(),
): HostRuntime {
  if (platform === "windows") {
    return createWindowsHostRuntime(
      process.env.ORYNODE_DATA_ROOT || undefined,
    );
  }
  return createMacosHostRuntime(projectRoot);
}
