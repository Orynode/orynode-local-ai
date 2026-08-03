/**
 * /api/status — 经 ModelRuntime port 探测本地推理
 */

import {
  TURBO_FIELDFARE_URL,
  EXPECTED_MODEL_ID,
  modelDisplayName,
} from "../../../config/defaults";
import {
  createRuntimeServices,
  lanDeniedResponse,
} from "../../../services/platform";

export async function GET(request: Request) {
  const denied = lanDeniedResponse(request);
  if (denied) return denied;
  try {
    const runtime = createRuntimeServices();
    const [models, health] = await Promise.all([
      runtime.model.listModels(),
      runtime.model.health(),
    ]);
    const ids = models.map((m) => m.id);
    const matched = ids.includes(EXPECTED_MODEL_ID);
    const fallback = ids.length > 0 ? ids[0]! : EXPECTED_MODEL_ID;
    const modelId = matched ? EXPECTED_MODEL_ID : fallback;

    return Response.json({
      connected: health.ok || matched || ids.length > 0,
      baseUrl: TURBO_FIELDFARE_URL,
      modelId,
      modelName: modelDisplayName(modelId),
      platform: runtime.host.platform,
      modelRuntime: (await runtime.host.capabilities()).modelRuntime,
    });
  } catch {
    return Response.json({
      connected: false,
      baseUrl: TURBO_FIELDFARE_URL,
      modelId: EXPECTED_MODEL_ID,
      modelName: modelDisplayName(EXPECTED_MODEL_ID),
    });
  }
}
