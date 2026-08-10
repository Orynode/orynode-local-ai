/**
 * 默认 OfficeConverter：@firecrawl/anydoc（同进程 libuv，**仅本地库**）。
 *
 * 职责仅限：加载原生包 → toMarkdownBytes → canonicalizeOfficeMarkdown。
 * 不做 document model / assets 物化（会把嵌入图抬进 JS 堆，违反产品契约）。
 *
 * 硬禁止：调用 Firecrawl 云端 Parse / 其它托管文档解析 API。
 */

import { OFFICE_CONFIG } from "../../../config/defaults";
import type { OfficeFormat } from "../formats";
import { EXT_BY_OFFICE_FORMAT } from "../formats";
import { canonicalizeOfficeMarkdown } from "../office-markdown";
import {
  OfficeConvertError,
  type OfficeConvertBudget,
  type OfficeConvertResult,
  type OfficeConverter,
} from "../ports/office-converter";

/** anydoc Format 枚举值 → 本仓库 OfficeFormat（与 registry 对齐，无独立 xls） */
function mapAnydocFormat(raw: unknown): OfficeFormat | null {
  const s = String(raw ?? "").toLowerCase();
  const aliases: Record<string, OfficeFormat> = {
    doc: "doc",
    docx: "docx",
    odt: "odt",
    ppt: "ppt",
    pptx: "pptx",
    rtf: "rtf",
    epub: "epub",
    xlsx: "xlsx",
    xls: "xlsx",
    ods: "ods",
    odp: "odp",
    csv: "csv",
    word: "docx",
    powerpoint: "pptx",
    excel: "xlsx",
    spreadsheet: "xlsx",
    presentation: "pptx",
  };
  return aliases[s] ?? null;
}

type AnydocErrorCode =
  | "unsupported"
  | "malformed"
  | "encrypted"
  | "resourceLimit"
  | "missingPart"
  | "io";

function readAnydocErrorCode(error: unknown): AnydocErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const code = "code" in error ? String((error as { code: unknown }).code) : "";
  if (
    code === "unsupported" ||
    code === "malformed" ||
    code === "encrypted" ||
    code === "resourceLimit" ||
    code === "missingPart" ||
    code === "io"
  ) {
    return code;
  }
  return null;
}

function mapAnydocError(error: unknown): OfficeConvertError {
  const message = error instanceof Error ? error.message : String(error);
  const code = readAnydocErrorCode(error);
  if (code === "encrypted") {
    return new OfficeConvertError("Encrypted", message);
  }
  if (code === "unsupported") {
    return new OfficeConvertError("Unsupported", message);
  }
  if (code === "malformed") {
    return new OfficeConvertError("Malformed", message);
  }
  if (code === "resourceLimit") {
    return new OfficeConvertError("ResourceLimit", message);
  }
  if (code === "missingPart") {
    return new OfficeConvertError("MissingPart", message);
  }
  if (code === "io") {
    return new OfficeConvertError("Io", message);
  }
  const lower = message.toLowerCase();
  if (lower.includes("encrypt")) {
    return new OfficeConvertError("Encrypted", message);
  }
  if (lower.includes("unsupported") || lower.includes("not support")) {
    return new OfficeConvertError("Unsupported", message);
  }
  if (lower.includes("timeout")) {
    return new OfficeConvertError("Timeout", message);
  }
  if (lower.includes("resource") || lower.includes("limit")) {
    return new OfficeConvertError("ResourceLimit", message);
  }
  return new OfficeConvertError("Malformed", message || "Office 转换失败");
}

async function loadAnydoc(): Promise<{
  toMarkdownBytes: (
    bytes: Uint8Array,
    format?: string,
  ) => Promise<string>;
  formatFromBytes?: (bytes: Uint8Array) => unknown;
}> {
  try {
    return await import("@firecrawl/anydoc");
  } catch (error) {
    throw new OfficeConvertError(
      "Unavailable",
      `无法加载 @firecrawl/anydoc：${error instanceof Error ? error.message : error}`,
    );
  }
}

async function sniffOfficeFormat(
  bytes: Uint8Array,
  hint?: OfficeFormat | null,
): Promise<OfficeFormat | null> {
  if (hint) return hint;
  const anydoc = await loadAnydoc();
  return mapAnydocFormat(anydoc.formatFromBytes?.(bytes)) ?? null;
}

export function createAnydocOfficeConverter(): OfficeConverter {
  return {
    id: "anydoc",
    async detectFormat(bytes, hint) {
      return sniffOfficeFormat(bytes, hint);
    },
    async convert(bytes, options = {}) {
      const budget: OfficeConvertBudget = options.budget ?? {
        timeoutMs: OFFICE_CONFIG.convertTimeoutMs,
        maxOutputChars: OFFICE_CONFIG.maxOutputChars,
        maxSlidesOrSheets: OFFICE_CONFIG.maxSlidesOrSheets,
      };
      const format = await sniffOfficeFormat(bytes, options.hint);
      if (!format) {
        throw new OfficeConvertError("Unsupported", "无法识别 Office 格式");
      }

      const anydoc = await loadAnydoc();
      const formatArg = EXT_BY_OFFICE_FORMAT[format] ?? format;
      const work = (async (): Promise<OfficeConvertResult> => {
        try {
          // 刻意不用 toDocument：会物化 Document.assets（嵌入图字节）。
          const raw = await anydoc.toMarkdownBytes(bytes, formatArg);
          const canonical = canonicalizeOfficeMarkdown(raw, format, budget);
          return {
            markdown: canonical.markdown,
            format,
            pageCountHint: canonical.pageCountHint,
            warnings: canonical.warnings,
          };
        } catch (error) {
          if (error instanceof OfficeConvertError) throw error;
          throw mapAnydocError(error);
        }
      })();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new OfficeConvertError(
              "Timeout",
              `Office 转换超时（${budget.timeoutMs}ms）`,
            ),
          );
        }, budget.timeoutMs);
      });

      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

let singleton: OfficeConverter | null = null;

export function getDefaultOfficeConverter(): OfficeConverter {
  if (!singleton) singleton = createAnydocOfficeConverter();
  return singleton;
}

/** Node-only：真正加载原生 @firecrawl/anydoc。Web / vinext 请用 office-probe。 */
export async function probeOfficeConverterRuntime(): Promise<"anydoc" | "none"> {
  try {
    await loadAnydoc();
    return "anydoc";
  } catch {
    return "none";
  }
}
