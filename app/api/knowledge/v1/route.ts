/**
 * /api/knowledge/v1 — 稳定公开 API 面（Phase 5）
 *
 * GET：capabilities。POST：与 /v1/search 同义（共用 runKnowledgeSearch / engine.search）。
 * 不得静态 import connectors/builtins 或 adapters（jsdom / sqlite-vec）。
 */

import {
  getKnowledgeCapabilities,
  readKnowledgeTierSetting,
} from "../../../../services/knowledge/application/capabilities";
import {
  knowledgeSearchBodySchema,
  runKnowledgeSearch,
} from "../../../../services/knowledge/application/run-search";
import { describeIndexBackend } from "../../../../services/knowledge/adapters/index-backend-info";
import { listConnectorTypes } from "../../../../services/knowledge/connectors/registry";
import { lanDeniedResponse } from "../../../../services/platform";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  const tier = await readKnowledgeTierSetting();
  const capabilities = await getKnowledgeCapabilities(tier);
  const decision = describeIndexBackend();
  return Response.json({
    apiVersion: "v1",
    capabilities: {
      ...capabilities,
      ocr: capabilities.ocrDetail,
      indexBackend: decision.id,
      indexDecision: decision,
      connectors: listConnectorTypes(),
    },
  });
}

export async function POST(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const raw = await request.json();
    const parsed = knowledgeSearchBodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "需要非空 query", code: "invalid_scope" },
        { status: 400 },
      );
    }
    const result = await runKnowledgeSearch(parsed.data);
    const { emptyScope: _empty, ...payload } = result;
    return Response.json({ apiVersion: "v1", ...payload });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "检索失败",
        code: "retrieval_failed",
      },
      { status: 502 },
    );
  }
}
