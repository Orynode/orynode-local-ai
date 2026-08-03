/**
 * Trusted-LAN pairing API（Web 面）
 *
 * - claim：局域网设备用配对码换 session cookie（无需已登录）
 * - start / list / revoke：须 session，或真实 loopback 客户端地址
 *
 * 本机 Settings 管理配对请优先直连 Data Service `http://127.0.0.1:4318/lan-auth/pairing`
 *（仅 loopback 可达，避免 Host 头伪造）。
 */

import {
  createLanAuthStore,
  requireLanAccess,
  sessionCookieHeader,
} from "../../../../services/platform/lan-auth";

const store = createLanAuthStore();

export async function GET(request: Request) {
  const access = requireLanAccess(request, {
    store,
    allowLoopbackWithoutSession: true,
  });
  if (!access.ok) {
    return Response.json(
      {
        error: access.error,
        code: access.code,
        hint: "请在服务器本机浏览器打开设置，或直连 http://127.0.0.1:4318/lan-auth/pairing",
      },
      { status: access.status },
    );
  }
  return Response.json({
    sessions: store.listSessions(),
    unsafePreview:
      process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "1" ||
      process.env.ORYNODE_TRUSTED_LAN_UNSAFE === "true",
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = body.action === "claim" ? "claim" : "start";

  if (action === "start") {
    const access = requireLanAccess(request, {
      store,
      allowLoopbackWithoutSession: true,
    });
    if (!access.ok) {
      return Response.json(
        {
          error: access.error,
          code: access.code,
          hint: "请在服务器本机浏览器生成配对码（Data Service /lan-auth/pairing）",
        },
        { status: access.status },
      );
    }
    const challenge = store.startPairing();
    return Response.json({
      pairing: {
        code: challenge.code,
        expiresAt: challenge.expiresAt,
      },
    });
  }

  const claimed = store.claimPairing({
    code: String(body.code || ""),
    label: typeof body.label === "string" ? body.label : undefined,
  });
  if (!claimed) {
    return Response.json(
      { error: "配对码无效或已过期", code: "PAIRING_INVALID" },
      { status: 400 },
    );
  }
  return Response.json(
    {
      session: {
        id: claimed.session.id,
        label: claimed.session.label,
        expiresAt: claimed.session.expiresAt,
      },
    },
    {
      headers: {
        "set-cookie": sessionCookieHeader(claimed.token),
      },
    },
  );
}

export async function DELETE(request: Request) {
  const access = requireLanAccess(request, {
    store,
    allowLoopbackWithoutSession: true,
  });
  if (!access.ok) {
    return Response.json(
      { error: access.error, code: access.code },
      { status: access.status },
    );
  }
  const body = await request.json().catch(() => ({}));
  const id = String(body.sessionId || "");
  if (!id) {
    return Response.json({ error: "需要 sessionId" }, { status: 400 });
  }
  const ok = store.revokeSession(id);
  return Response.json({ revoked: ok }, { status: ok ? 200 : 404 });
}
