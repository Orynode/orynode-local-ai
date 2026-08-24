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

/**
 * zip 容器（OOXML/ODF）未压缩总大小预检上限。
 * 高压缩比包（zip bomb）会在原生库内部物化成 GB 级字符串，
 * 输出预算裁剪发生在 toMarkdownBytes 返回之后，无法阻止内存峰值；
 * 读 central directory 预检是唯一便宜的拦截点。
 */
const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * 解析 zip central directory 累加未压缩大小。
 * 只读文件尾 + 目录项，不触碰本地条目数据；解析失败返回 null（交由后续流程处理）。
 */
function estimateZipUncompressedSize(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部向前找 EOCD 签名 0x06054b50
  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= minEocd; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > bytes.length) return null;

  let total = 0;
  const limit = cdOffset + cdSize;
  let pos = cdOffset;
  for (let i = 0; i < entryCount && pos + 46 <= limit; i += 1) {
    if (view.getUint32(pos, true) !== 0x02014b50) return null;
    // zip64 条目：uncompressed size 为 0xFFFFFFFF，真实值在 zip64 extra 字段；
    // 此处保守按超限处理（拒绝而非低估）
    const size32 = view.getUint32(pos + 24, true);
    total += size32 === 0xffffffff ? MAX_ZIP_UNCOMPRESSED_BYTES + 1 : size32;
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) return total;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

function assertZipInputBudget(bytes: Uint8Array, format: OfficeFormat): void {
  if (!["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(format)) {
    return;
  }
  const uncompressed = estimateZipUncompressedSize(bytes);
  if (uncompressed != null && uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new OfficeConvertError(
      "ResourceLimit",
      `Office 包解压后体积超过上限（${MAX_ZIP_UNCOMPRESSED_BYTES} 字节）`,
    );
  }
}

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

async function loadAnydoc(): Promise<typeof import("@firecrawl/anydoc")> {
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
      assertZipInputBudget(bytes, format);

      const anydoc = await loadAnydoc();
      const formatArg =
        anydoc.formatFromExtension(EXT_BY_OFFICE_FORMAT[format] ?? format) ??
        undefined;
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
