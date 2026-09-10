/**
 * P3：审核沉淀候选。拒绝 pending_merge 时回滚对应笔记。
 */

import { randomUUID } from "node:crypto";
import {
  getWikiCandidate,
  patchWikiCandidateStatus,
  saveWikiDecision,
  type PersistedWikiPage,
  type WikiCandidateInput,
} from "./persist";
import { undoWikiSettle } from "./run-settle";

export type WikiCandidateReview = {
  candidate: WikiCandidateInput;
  page?: PersistedWikiPage | null;
};

export async function reviewWikiCandidate(input: {
  id: string;
  action: "accept" | "reject";
  getCandidate?: typeof getWikiCandidate;
  patchStatus?: typeof patchWikiCandidateStatus;
  undoSettle?: typeof undoWikiSettle;
  saveDecision?: typeof saveWikiDecision;
}): Promise<WikiCandidateReview> {
  const id = String(input.id || "").trim();
  if (!id) throw new Error("缺少候选");
  const getCandidate = input.getCandidate ?? getWikiCandidate;
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error("候选不存在");
  if (candidate.status && candidate.status !== "pending") {
    throw new Error("这条候选已经处理过");
  }
  let page: PersistedWikiPage | null | undefined;
  if (input.action === "reject" && candidate.kind === "pending_merge") {
    const undoSettle = input.undoSettle ?? undoWikiSettle;
    page = await undoSettle({
      settleId: candidate.id,
      pageId: candidate.pageId,
    });
  }
  const patchStatus = input.patchStatus ?? patchWikiCandidateStatus;
  const updated = await patchStatus(
    id,
    input.action === "accept" ? "accepted" : "rejected",
  );
  const saveDecision = input.saveDecision ?? saveWikiDecision;
  await saveDecision({
    id: randomUUID(),
    action: input.action,
    actor: "user",
    candidateId: id,
    pageId: candidate.pageId,
    settleId: candidate.id,
  }).catch(() => null);
  return { candidate: updated ?? { ...candidate, status: input.action === "accept" ? "accepted" : "rejected" }, page };
}
