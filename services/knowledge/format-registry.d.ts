/**
 * format-registry.mjs 的 TypeScript 声明（实现见同名 .mjs）
 */

export type KnowledgeFileKind = "pdf" | "txt" | "md" | "office";

/** 与 @firecrawl/anydoc Format 对齐（不含 pdf）；无独立 xls */
export type OfficeFormat =
  | "docx"
  | "doc"
  | "pptx"
  | "ppt"
  | "xlsx"
  | "odt"
  | "ods"
  | "odp"
  | "rtf"
  | "epub"
  | "csv";

export const FORMAT_ENTRIES: ReadonlyArray<{
  ext: string;
  kind: KnowledgeFileKind;
  officeFormat?: OfficeFormat;
  mimes: ReadonlyArray<string>;
}>;

export const OFFICE_FORMAT_SET: ReadonlySet<OfficeFormat>;
export const OFFICE_EXTS: ReadonlySet<string>;
export const OFFICE_MIME: ReadonlySet<string>;
export const KIND_BY_EXT: Readonly<Record<string, KnowledgeFileKind>>;
export const OFFICE_FORMAT_BY_EXT: Readonly<Record<string, OfficeFormat>>;
export const KIND_BY_MIME: Readonly<Record<string, KnowledgeFileKind>>;
export const MIME_BY_OFFICE_FORMAT: Readonly<Record<OfficeFormat, string>>;
export const EXT_BY_OFFICE_FORMAT: Readonly<Record<OfficeFormat, string>>;

export function extensionFromPath(name: string): string;
export function isZipMagic(bytes: Uint8Array | ArrayBuffer): boolean;
export function isPdfMagic(bytes: Uint8Array | ArrayBuffer): boolean;
export function kindFromFileName(name: string): KnowledgeFileKind | null;
export function kindFromMime(
  contentType: string | null | undefined,
): KnowledgeFileKind | null;
export function officeFormatFromFileName(name: string): OfficeFormat | null;
export function resolveKnowledgeFileKind(input: {
  fileKind?: string | null;
  paths?: Array<string | null | undefined>;
}): KnowledgeFileKind | null;
export function extensionForKind(
  kind: KnowledgeFileKind,
  officeFormat?: OfficeFormat | null,
): string;
export function mimeForKind(
  kind: KnowledgeFileKind,
  officeFormat?: OfficeFormat | null,
): string;
export function buildOfficeAccept(): string;

export const KNOWLEDGE_FILE_ACCEPT_CORE: string;
export const KNOWLEDGE_FILE_ACCEPT: string;
