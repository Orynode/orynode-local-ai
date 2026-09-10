/**
 * GET/POST /api/knowledge/wiki/decisions
 * 人工合并 / 拆分 / 接受 / 拒绝。自动编译不得覆盖这些决策。
 */

import { randomUUID } from "node:crypto";
import { lanDeniedResponse } from "../../../../../services/platform";
import {
  listWikiDecisions,
  saveWikiDecision,
} from "../../../../../services/knowledge/wiki/persist";
import type { WikiDecision } from "../../../../../services/knowledge/wiki/wiki-identity";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const decisions = await listWikiDecisions();
    return Response.json({ decisions });
  } catch {
    return Response.json({ error: "无法读取百科决策" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const body = (await request.json().catch(() => ({}))) as Partial<WikiDecision>;
    const action = body.action;
    if (
      action !== "merge" &&
      action !== "split" &&
      action !== "accept" &&
      action !== "reject" &&
      action !== "undo"
    ) {
      return Response.json({ error: "缺少有效决策" }, { status: 400 });
    }
    const decision = await saveWikiDecision({
      ...body,
      id: String(body.id || randomUUID()),
      action,
      actor: body.actor || "user",
    });
    return Response.json({ decision }, { status: 201 });
  } catch {
    return Response.json({ error: "无法保存百科决策" }, { status: 503 });
  }
}
