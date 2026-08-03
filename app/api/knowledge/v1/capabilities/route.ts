/**
 * GET /api/knowledge/v1/capabilities
 *
 * Workers 安全：不加载 jsdom / sqlite-vec。
 */

import {
  getKnowledgeCapabilities,
  readKnowledgeTierSetting,
} from "../../../../../services/knowledge/application/capabilities";
import { describeIndexBackend } from "../../../../../services/knowledge/adapters/index-backend-info";
import { listConnectorTypes } from "../../../../../services/knowledge/connectors/registry";
import { lanDeniedResponse } from "../../../../../services/platform";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
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
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "能力探测失败",
        code: "retrieval_failed",
      },
      { status: 502 },
    );
  }
}
