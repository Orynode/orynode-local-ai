/**
 * GET /api/knowledge/capabilities — 主机能力 + 有效档位
 */

import {
  getKnowledgeCapabilities,
  readKnowledgeTierSetting,
} from "../../../../services/knowledge/application/capabilities";
import { parseKnowledgeTier } from "../../../../config/defaults";
import { lanDeniedResponse } from "../../../../services/platform";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const tierParam = parseKnowledgeTier(url.searchParams.get("tier"));
    const requested = tierParam ?? (await readKnowledgeTierSetting());
    const capabilities = await getKnowledgeCapabilities(requested);
    return Response.json({
      ...capabilities,
      capabilities: {
        ...capabilities,
        ocr: capabilities.ocrDetail,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "能力探测失败",
      },
      { status: 502 },
    );
  }
}
