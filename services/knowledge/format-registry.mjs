/**
 * 知识文件格式唯一真相源（ext / mime / kind / officeFormat）。
 *
 * formats.ts、preview、data-service 均应消费本模块，禁止再手抄 OFFICE_EXTS。
 * officeFormat 对齐 @firecrawl/anydoc Format（不含 pdf；pdf 仍为独立 kind）。
 * 容器变体（docm/xlsm/…）映射到基格式；.xls → xlsx（与 anydoc formatFromExtension 一致）。
 * 迁移 016 为历史回填快照；新增扩展名请改本文件（file_kind 仍为 office，通常无需新迁移）。
 */

/** @typedef {"pdf"|"txt"|"md"|"office"} KnowledgeFileKind */
/** @typedef {"docx"|"doc"|"pptx"|"ppt"|"xlsx"|"odt"|"ods"|"odp"|"rtf"|"epub"|"csv"} OfficeFormat */

/**
 * @type {ReadonlyArray<{
 *   ext: string,
 *   kind: KnowledgeFileKind,
 *   officeFormat?: OfficeFormat,
 *   mimes: ReadonlyArray<string>,
 * }>}
 */
export const FORMAT_ENTRIES = Object.freeze([
  { ext: ".pdf", kind: "pdf", mimes: ["application/pdf"] },
  { ext: ".txt", kind: "txt", mimes: ["text/plain"] },
  {
    ext: ".md",
    kind: "md",
    mimes: ["text/markdown", "text/x-markdown"],
  },
  { ext: ".markdown", kind: "md", mimes: [] },

  // —— Word：变体在前，主扩展在后（见 PRIMARY_EXT_BY_OFFICE_FORMAT）——
  {
    ext: ".doc",
    kind: "office",
    officeFormat: "doc",
    mimes: ["application/msword"],
  },
  {
    ext: ".docm",
    kind: "office",
    officeFormat: "docx",
    mimes: [
      "application/vnd.ms-word.document.macroEnabled.12",
    ],
  },
  {
    ext: ".docx",
    kind: "office",
    officeFormat: "docx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },

  // —— PowerPoint ——
  {
    ext: ".ppt",
    kind: "office",
    officeFormat: "ppt",
    mimes: ["application/vnd.ms-powerpoint"],
  },
  {
    ext: ".pptm",
    kind: "office",
    officeFormat: "pptx",
    mimes: [
      "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    ],
  },
  {
    ext: ".ppsx",
    kind: "office",
    officeFormat: "pptx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ],
  },
  {
    ext: ".ppsm",
    kind: "office",
    officeFormat: "pptx",
    mimes: [
      "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
    ],
  },
  {
    ext: ".pptx",
    kind: "office",
    officeFormat: "pptx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },

  // —— Excel：变体/.xls → xlsx；主扩展 .xlsx 最后 ——
  {
    ext: ".xls",
    kind: "office",
    officeFormat: "xlsx",
    mimes: ["application/vnd.ms-excel"],
  },
  {
    ext: ".xlsm",
    kind: "office",
    officeFormat: "xlsx",
    mimes: [
      "application/vnd.ms-excel.sheet.macroEnabled.12",
    ],
  },
  {
    ext: ".xlsb",
    kind: "office",
    officeFormat: "xlsx",
    mimes: ["application/vnd.ms-excel.sheet.binary.macroEnabled.12"],
  },
  {
    ext: ".xlsx",
    kind: "office",
    officeFormat: "xlsx",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },

  // —— OpenDocument / 其它 ——
  {
    ext: ".odt",
    kind: "office",
    officeFormat: "odt",
    mimes: ["application/vnd.oasis.opendocument.text"],
  },
  {
    ext: ".ods",
    kind: "office",
    officeFormat: "ods",
    mimes: ["application/vnd.oasis.opendocument.spreadsheet"],
  },
  {
    ext: ".odp",
    kind: "office",
    officeFormat: "odp",
    mimes: ["application/vnd.oasis.opendocument.presentation"],
  },
  {
    ext: ".rtf",
    kind: "office",
    officeFormat: "rtf",
    mimes: ["application/rtf", "text/rtf"],
  },
  {
    ext: ".epub",
    kind: "office",
    officeFormat: "epub",
    mimes: ["application/epub+zip"],
  },
  {
    ext: ".csv",
    kind: "office",
    officeFormat: "csv",
    mimes: ["text/csv", "application/csv"],
  },
]);

/** @type {ReadonlySet<OfficeFormat>} */
export const OFFICE_FORMAT_SET = Object.freeze(
  new Set(
    FORMAT_ENTRIES.filter((e) => e.kind === "office" && e.officeFormat).map(
      (e) => e.officeFormat,
    ),
  ),
);

/** 无点号，如 docx — data-service 存储扩展名用 */
export const OFFICE_EXTS = Object.freeze(
  new Set(
    FORMAT_ENTRIES.filter((e) => e.kind === "office").map((e) =>
      e.ext.slice(1),
    ),
  ),
);

/** @type {ReadonlySet<string>} */
export const OFFICE_MIME = Object.freeze(
  new Set(
    FORMAT_ENTRIES.filter((e) => e.kind === "office").flatMap((e) => [
      ...e.mimes,
    ]),
  ),
);

/** @type {Readonly<Record<string, KnowledgeFileKind>>} */
export const KIND_BY_EXT = Object.freeze(
  Object.fromEntries(FORMAT_ENTRIES.map((e) => [e.ext, e.kind])),
);

/** @type {Readonly<Record<string, OfficeFormat>>} */
export const OFFICE_FORMAT_BY_EXT = Object.freeze(
  Object.fromEntries(
    FORMAT_ENTRIES.filter((e) => e.officeFormat).map((e) => [
      e.ext,
      e.officeFormat,
    ]),
  ),
);

/** @type {Readonly<Record<string, KnowledgeFileKind>>} */
export const KIND_BY_MIME = Object.freeze(
  Object.fromEntries(
    FORMAT_ENTRIES.flatMap((e) => e.mimes.map((m) => [m, e.kind])),
  ),
);

/** @type {Readonly<Record<OfficeFormat, string>>} */
export const MIME_BY_OFFICE_FORMAT = Object.freeze(
  Object.fromEntries(
    FORMAT_ENTRIES.filter((e) => e.officeFormat && e.mimes[0]).map((e) => [
      e.officeFormat,
      e.mimes[0],
    ]),
  ),
);

/**
 * anydoc / 存储用的主扩展名（无点）。变体扩展不得写入此表。
 * @type {Readonly<Record<OfficeFormat, string>>}
 */
export const EXT_BY_OFFICE_FORMAT = Object.freeze({
  doc: "doc",
  docx: "docx",
  ppt: "ppt",
  pptx: "pptx",
  xlsx: "xlsx",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  rtf: "rtf",
  epub: "epub",
  csv: "csv",
});

export function isZipMagic(bytes) {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    view.byteLength >= 4 &&
    view[0] === 0x50 &&
    view[1] === 0x4b &&
    (view[2] === 0x03 || view[2] === 0x05 || view[2] === 0x07) &&
    (view[3] === 0x04 || view[3] === 0x06 || view[3] === 0x08)
  );
}

export function isPdfMagic(bytes) {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const limit = Math.min(view.byteLength, 1024);
  for (let i = 0; i <= limit - 5; i += 1) {
    if (
      view[i] === 0x25 &&
      view[i + 1] === 0x50 &&
      view[i + 2] === 0x44 &&
      view[i + 3] === 0x46 &&
      view[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} name
 * @returns {string} 含点小写扩展名，或 ""
 */
export function extensionFromPath(name) {
  const lower = String(name || "")
    .trim()
    .toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "";
  return lower.slice(dot);
}

/**
 * @param {string} name
 * @returns {KnowledgeFileKind | null}
 */
export function kindFromFileName(name) {
  const ext = extensionFromPath(name);
  return ext ? (KIND_BY_EXT[ext] ?? null) : null;
}

/**
 * @param {string | null | undefined} contentType
 * @returns {KnowledgeFileKind | null}
 */
export function kindFromMime(contentType) {
  if (!contentType) return null;
  const mime = String(contentType).split(";")[0]?.trim().toLowerCase();
  return mime ? (KIND_BY_MIME[mime] ?? null) : null;
}

/**
 * @param {string} name
 * @returns {OfficeFormat | null}
 */
export function officeFormatFromFileName(name) {
  const ext = extensionFromPath(name);
  return ext ? (OFFICE_FORMAT_BY_EXT[ext] ?? null) : null;
}

/**
 * DB file_kind 优先；缺失时按路径扩展名用同一 registry 推断。
 * @param {{
 *   fileKind?: string | null,
 *   paths?: Array<string | null | undefined>,
 * }} input
 * @returns {KnowledgeFileKind | null}
 */
export function resolveKnowledgeFileKind(input) {
  const raw = typeof input.fileKind === "string" ? input.fileKind.trim() : "";
  if (raw === "pdf" || raw === "txt" || raw === "md" || raw === "office") {
    return raw;
  }
  for (const path of input.paths ?? []) {
    const kind = kindFromFileName(path ?? "");
    if (kind) return kind;
  }
  return null;
}

/**
 * @param {KnowledgeFileKind} kind
 * @param {OfficeFormat | null | undefined} [officeFormat]
 */
export function extensionForKind(kind, officeFormat) {
  if (kind === "pdf") return "pdf";
  if (kind === "md") return "md";
  if (kind === "office") {
    const fmt = officeFormat && EXT_BY_OFFICE_FORMAT[officeFormat]
      ? officeFormat
      : "docx";
    return EXT_BY_OFFICE_FORMAT[fmt] ?? "docx";
  }
  return "txt";
}

/**
 * @param {KnowledgeFileKind} kind
 * @param {OfficeFormat | null | undefined} [officeFormat]
 */
export function mimeForKind(kind, officeFormat) {
  if (kind === "pdf") return "application/pdf";
  if (kind === "md") return "text/markdown";
  if (kind === "office") {
    const fmt =
      officeFormat && MIME_BY_OFFICE_FORMAT[officeFormat]
        ? officeFormat
        : "docx";
    return MIME_BY_OFFICE_FORMAT[fmt] ?? MIME_BY_OFFICE_FORMAT.docx;
  }
  return "text/plain";
}

/** 由 registry 生成的 Office accept 片段 */
export function buildOfficeAccept() {
  const exts = FORMAT_ENTRIES.filter((e) => e.kind === "office")
    .map((e) => e.ext)
    .join(",");
  const mimes = [...OFFICE_MIME].join(",");
  return `${exts},${mimes}`;
}

export const KNOWLEDGE_FILE_ACCEPT_CORE =
  "application/pdf,.pdf,text/plain,.txt,text/markdown,.md,.markdown";

export const KNOWLEDGE_FILE_ACCEPT = `${KNOWLEDGE_FILE_ACCEPT_CORE},${buildOfficeAccept()}`;
