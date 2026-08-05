export type {
  AccessMode,
  HostCapabilities,
  HostPlatform,
  HostRuntime,
  ModelRuntime,
  OcrEngine,
  RuntimePaths,
} from "./types";
export type {
  HostMemoryClass,
  KnowledgeMemoryTier,
  MemoryPressure,
  MemoryRuntimePreset,
} from "./host-memory";
export {
  classifyHostMemory,
  recommendedMaxContext,
  recommendedRuntimePreset,
  hostMemoryClassLabel,
  hostKnowledgeCeiling,
  resolveMemoryPressure,
  memoryPressureToResourcePressure,
  HOST_MEMORY_LOW_MAX_BYTES,
  HOST_MEMORY_MEDIUM_MAX_BYTES,
} from "./host-memory";
export { createMacosHostRuntime } from "./macos/index";
export { createWindowsHostRuntime } from "./windows/index";
export {
  createWindowsOcrReservedStub,
  readWindowsOcrArtifactManifest,
  WINDOWS_OCR_ENGINE_ID,
} from "./windows/ocr-reserved";
export { createHostRuntime, detectHostPlatform } from "./factory";
export {
  createRuntimeServices,
  resetRuntimeServicesForTests,
} from "./composition-root";
export type { RuntimeServices } from "./composition-root";
export { resolveAccessMode, trustedLanUnsafeAllowed, webBindHost } from "./access";
export {
  toStorageKey,
  sanitizeFileName,
  looksLikeWindowsAbsolutePath,
  assertRelativeStorageKey,
} from "./paths";
export {
  createLanAuthStore,
  requireLanAccess,
  resolveClientAddress,
  isLoopbackAddress,
  LAN_SESSION_COOKIE,
} from "./lan-auth";
export type { LanSession, PairingChallenge } from "./lan-auth";
export { lanDeniedResponse } from "./http-guard";
