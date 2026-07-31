/**
 * /api/status — 共用 inferenceService
 */

import {
  TURBO_FIELDFARE_URL,
  EXPECTED_MODEL_ID,
  modelDisplayName,
} from "../../../config/defaults";
import { inferenceService } from "../../../services/inference/turbo-fieldfare";

export async function GET() {
  try {
    const models = await inferenceService.listModels();
    const matched = models.includes(EXPECTED_MODEL_ID);
    const fallback = models.length > 0 ? models[0] : EXPECTED_MODEL_ID;
    const modelId = matched ? EXPECTED_MODEL_ID : fallback;

    return Response.json({
      connected: matched || models.length > 0,
      baseUrl: TURBO_FIELDFARE_URL,
      modelId,
      modelName: modelDisplayName(modelId),
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
