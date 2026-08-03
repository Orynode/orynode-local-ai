export type {
  AccessMode,
  HostCapabilities,
  HostPlatform,
  HostRuntime,
  ModelRuntime,
  OcrEngine,
  RuntimePaths,
} from "./types";
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
