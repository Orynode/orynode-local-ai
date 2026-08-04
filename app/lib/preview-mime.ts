/** 预览 MIME / 种类探测（纯函数，便于单测） */

export type PreviewKind = "pdf" | "text" | "unknown";

export function looksLikePdf(bytes: ArrayBuffer | Uint8Array): boolean {
  const sample =
    bytes instanceof Uint8Array
      ? bytes.subarray(0, Math.min(bytes.byteLength, 1024))
      : new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024));
  for (let i = 0; i <= sample.length - 5; i += 1) {
    if (
      sample[i] === 0x25 &&
      sample[i + 1] === 0x50 &&
      sample[i + 2] === 0x44 &&
      sample[i + 3] === 0x46 &&
      sample[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

export function previewKindFromMeta(
  contentType: string | null | undefined,
  fileName: string,
  headBytes?: ArrayBuffer | Uint8Array,
): PreviewKind {
  const type = (contentType || "").toLowerCase();
  const lower = fileName.toLowerCase();
  if (type.includes("pdf") || lower.endsWith(".pdf")) return "pdf";
  if (headBytes && looksLikePdf(headBytes)) return "pdf";
  if (
    type.includes("text/") ||
    type.includes("markdown") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".txt")
  ) {
    return "text";
  }
  return "unknown";
}

export function decodePreviewFileName(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/** 从流中最多读取 maxBytes；用于文本预览截断与 PDF 魔数探测 */
export async function readResponsePrefix(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const result = await readResponseUpTo(response, maxBytes);
  return { bytes: result.bytes, truncated: result.truncated };
}

/**
 * 持续读取直至 maxBytes 或流结束；会消费 body，调用后不可再次读取。
 */
async function readResponseUpTo(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean; complete: boolean }> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength <= maxBytes) {
      return { bytes: buf, truncated: false, complete: true };
    }
    return {
      bytes: buf.subarray(0, maxBytes),
      truncated: true,
      complete: false,
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = !truncated;
        break;
      }
      if (!value?.byteLength) continue;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
      const room = maxBytes - total;
      if (value.byteLength <= room) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated, complete };
}

/** 将 Uint8Array 转为可独立持有的 ArrayBuffer（避免 SharedArrayBuffer 视图问题） */
export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function pullUpTo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  total: number,
  maxBytes: number,
): Promise<{ total: number; ended: boolean }> {
  let ended = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    if (!value?.byteLength) continue;
    const room = maxBytes - total;
    if (value.byteLength <= room) {
      chunks.push(value);
      total += value.byteLength;
    } else {
      chunks.push(value.subarray(0, room));
      total += room;
      break;
    }
  }
  return { total, ended };
}

export type ResolvedOriginal =
  | { kind: "pdf"; mode: "data"; data: ArrayBuffer }
  | { kind: "pdf"; mode: "url" }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "unknown" };

/**
 * HEAD 无法判定类型时：一次 GET 流上先 peek 再按需续读，避免 PDF 小文件二次下载。
 */
export async function resolveOriginalFromResponse(
  response: Response,
  input: {
    contentType: string | null;
    fileName: string;
    contentLength: number;
    textMaxBytes: number;
    pdfBufferMaxBytes: number;
  },
): Promise<ResolvedOriginal> {
  const peekBytes = 1024;
  const canBufferPdf =
    input.contentLength > 0 &&
    input.contentLength <= input.pdfBufferMaxBytes;

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    const kind = previewKindFromMeta(input.contentType, input.fileName, buf);
    if (kind === "pdf") {
      if (canBufferPdf || buf.byteLength <= input.pdfBufferMaxBytes) {
        const slice =
          buf.byteLength <= input.pdfBufferMaxBytes
            ? buf
            : buf.subarray(0, input.pdfBufferMaxBytes);
        return { kind: "pdf", mode: "data", data: bytesToArrayBuffer(slice) };
      }
      return { kind: "pdf", mode: "url" };
    }
    if (kind === "text") {
      const slice =
        buf.byteLength <= input.textMaxBytes
          ? buf
          : buf.subarray(0, input.textMaxBytes);
      return {
        kind: "text",
        text: new TextDecoder("utf-8", { fatal: false }).decode(slice),
        truncated: buf.byteLength > input.textMaxBytes,
      };
    }
    return { kind: "unknown" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let ended = false;
    ({ total, ended } = await pullUpTo(reader, chunks, total, peekBytes));
    const peek = concatChunks(chunks, total);
    const kind = previewKindFromMeta(input.contentType, input.fileName, peek);

    if (kind === "pdf") {
      if (canBufferPdf) {
        if (total < input.contentLength) {
          ({ total, ended } = await pullUpTo(
            reader,
            chunks,
            total,
            input.contentLength,
          ));
        }
        return {
          kind: "pdf",
          mode: "data",
          data: bytesToArrayBuffer(concatChunks(chunks, total)),
        };
      }
      // 无 Content-Length：若 peek 已读完整段且很小，直接缓冲
      if (input.contentLength <= 0 && ended && total <= input.pdfBufferMaxBytes) {
        return {
          kind: "pdf",
          mode: "data",
          data: bytesToArrayBuffer(concatChunks(chunks, total)),
        };
      }
      return { kind: "pdf", mode: "url" };
    }

    if (kind === "text") {
      if (total < input.textMaxBytes) {
        ({ total } = await pullUpTo(
          reader,
          chunks,
          total,
          input.textMaxBytes,
        ));
      }
      const raw = concatChunks(chunks, total);
      const truncated =
        raw.byteLength > input.textMaxBytes ||
        (input.contentLength > input.textMaxBytes && input.contentLength > 0);
      const bytes =
        raw.byteLength > input.textMaxBytes
          ? raw.subarray(0, input.textMaxBytes)
          : raw;
      return {
        kind: "text",
        text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        truncated,
      };
    }

    return { kind: "unknown" };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** 面向用户的体积文案（预览提示条） */
export function formatPreviewBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 计算文本中目标行（1-based）起始字符偏移 */
export function lineStartOffset(text: string, startLine: number): number {
  let offset = 0;
  let line = 1;
  while (line < startLine && offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(offset, text.length);
}
