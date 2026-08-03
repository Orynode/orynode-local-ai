/**
 * API 网关辅助：Trusted-LAN 统一鉴权
 */

import { requireLanAccess } from "./lan-auth";

/** 若拒绝访问则返回 Response；通过则返回 null */
export function lanDeniedResponse(request: Request): Response | null {
  const access = requireLanAccess(request);
  if (access.ok) return null;
  return Response.json(
    { error: access.error, code: access.code },
    { status: access.status },
  );
}
