/**
 * 术语库 HTTP 客户端（data-service 持久化）
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";
import type { TerminologyEntry } from "./terminology";

export type LearnedTerminologyEntry = TerminologyEntry & {
  source?: string;
  hitCount?: number;
};

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function listLearnedTerminology(): Promise<LearnedTerminologyEntry[]> {
  const body = await getJson<{ entries?: LearnedTerminologyEntry[] }>(
    "/terminology/entries",
  );
  return Array.isArray(body?.entries) ? body.entries : [];
}

export async function upsertLearnedTerminology(input: {
  id?: string;
  domain?: string;
  terms: string[];
  exclude?: string[];
  source?: string;
}): Promise<LearnedTerminologyEntry | null> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/terminology/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { entry?: LearnedTerminologyEntry };
    return body.entry ?? null;
  } catch {
    return null;
  }
}

export async function recordTerminologyHit(id: string): Promise<void> {
  try {
    await fetch(`${ORYNODE_DATA_URL}/terminology/entries/hit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
  } catch {
    // ignore
  }
}
