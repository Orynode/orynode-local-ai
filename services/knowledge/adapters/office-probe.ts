/**
 * Office 转换能力探测（Web / vinext 安全）。
 *
 * 禁止在此文件 import `@firecrawl/anydoc`：原生 .node 不能进 Vite 预构建 / Workers。
 * 以 data-service（Node）真加载探测为准；不可达时返回 none。
 * Node 侧真加载请用 `office-anydoc.probeOfficeConverterRuntime`（勿与本函数同名）。
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../config/defaults";

function readOfficePayload(body: unknown): "anydoc" | "none" | null {
  if (!body || typeof body !== "object") return null;
  const office =
    "office" in body && body.office && typeof body.office === "object"
      ? (body.office as { available?: boolean; engine?: string | null })
      : (body as { available?: boolean; engine?: string | null });
  if (office.available === true) {
    if (office.engine == null || office.engine === "anydoc") return "anydoc";
  }
  if (office.available === false) return "none";
  return null;
}

/**
 * 询问本机 data-service（真加载）。
 * 不可达时返回 none——禁止仅凭 npm resolve 放开上传（原生 .node 可能仍加载失败）。
 */
export async function probeOfficeConverterAvailability(): Promise<
  "anydoc" | "none"
> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/knowledge/office/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.embeddingStatus),
    });
    if (response.ok) {
      const parsed = readOfficePayload(await response.json().catch(() => null));
      if (parsed) return parsed;
    }
  } catch {
    // continue
  }

  // 旧 data-service 无 office/status 时，读 /health.office
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.embeddingStatus),
    });
    if (response.ok) {
      const parsed = readOfficePayload(await response.json().catch(() => null));
      if (parsed) return parsed;
    }
  } catch {
    // continue
  }

  return "none";
}
