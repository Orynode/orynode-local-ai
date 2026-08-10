/**
 * OfficeConverter Port — 可替换的**本地** Office → Markdown 转换。
 *
 * anydoc 只是默认 adapter；禁止把厂商 SDK 写进 ingest.ts。
 * 产出 Markdown 后必须经 `canonicalizeOfficeMarkdown` 再入库。
 *
 * 硬禁止：Firecrawl 云端 Parse（及任何把原件发往第三方托管解析 API 的 adapter）。
 * 允许的实现只能在本机进程 / 本机受控子进程内完成转换。
 * 本版不物化嵌入图 bytes（见 office-contract）。
 */

export type { OfficeFormat } from "../format-registry.mjs";
import type { OfficeFormat } from "../format-registry.mjs";
export type { OfficeConvertWarning } from "../office-contract";
import type { OfficeConvertWarning } from "../office-contract";

export type OfficeConvertErrorCode =
  | "Encrypted"
  | "Unsupported"
  | "Malformed"
  | "ResourceLimit"
  | "Timeout"
  | "OutputTooLarge"
  | "Unavailable"
  | "MissingPart"
  | "Io";

export class OfficeConvertError extends Error {
  readonly code: OfficeConvertErrorCode;

  constructor(code: OfficeConvertErrorCode, message: string) {
    super(message);
    this.name = "OfficeConvertError";
    this.code = code;
  }
}

export interface OfficeConvertResult {
  markdown: string;
  format: OfficeFormat;
  pageCountHint?: number;
  /** 成功但内容降级（如 sheet/slide 截断）；由 Job 写入 error_message */
  warnings?: OfficeConvertWarning[];
}

export interface OfficeConvertBudget {
  timeoutMs: number;
  maxOutputChars: number;
  maxSlidesOrSheets: number;
}

export interface OfficeConverter {
  readonly id: string;
  /** 异步 sniff；无把握返回 null，由 convert 再判一次 */
  detectFormat(
    bytes: Uint8Array,
    hint?: OfficeFormat | null,
  ): Promise<OfficeFormat | null>;
  convert(
    bytes: Uint8Array,
    options?: {
      hint?: OfficeFormat | null;
      budget?: OfficeConvertBudget;
    },
  ): Promise<OfficeConvertResult>;
}
