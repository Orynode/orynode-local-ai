/**
 * 访问模式边界（Phase 1 + KE-P3-02）
 *
 * Local-only 为安全默认。
 * Trusted-LAN：
 * - 有 pairing/session 认证时可绑定局域网；
 * - ORYNODE_TRUSTED_LAN_UNSAFE=1 为无认证开发预览（不得描述为安全共享）。
 */

export type AccessMode = "local_only" | "trusted_lan";

function envTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * 是否允许在无认证情况下绑定局域网（显式风险确认）。
 */
export function trustedLanUnsafeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envTruthy(env.ORYNODE_TRUSTED_LAN_UNSAFE);
}

/**
 * Trusted-LAN 是否启用（含「需认证」正式路径与 UNSAFE 预览）。
 * 与历史行为不同：不再因缺少 UNSAFE 而静默降级为 local_only；
 * 正式路径由 requireLanAccess 强制 session。
 */
export function resolveAccessMode(
  env: NodeJS.ProcessEnv = process.env,
): AccessMode {
  if (env.ORYNODE_ACCESS_MODE !== "trusted_lan") {
    return "local_only";
  }
  return "trusted_lan";
}

export function webBindHost(mode: AccessMode): "127.0.0.1" | "0.0.0.0" {
  return mode === "trusted_lan" ? "0.0.0.0" : "127.0.0.1";
}
