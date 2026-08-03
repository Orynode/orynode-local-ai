/**
 * Orynode OCR helper JSON Lines 协议（macOS Swift CLI / fake helper）
 */

import { OCR_CONFIG } from "../../../config/defaults";
import type { OcrBlock, OcrPageResult } from "../types";
import { parseNormalizedBbox } from "../ocr/bbox";

export const OCR_HELPER_PROTOCOL_VERSION = OCR_CONFIG.helperProtocolVersion;

export type OcrHelperErrorCode =
  | "OCR_UNAVAILABLE"
  | "OCR_TIMEOUT"
  | "OCR_CANCELLED"
  | "OCR_HELPER_PROTOCOL_ERROR"
  | "OCR_INVALID_BBOX"
  | "OCR_PAGE_LIMIT_EXCEEDED";

export type OcrHelperRequest = {
  protocolVersion: number;
  requestId: string;
  pageNumber: number;
  imagePath: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  languages?: string[];
  recognitionLevel: "fast" | "accurate";
};

export type OcrHelperSuccess = {
  protocolVersion: number;
  requestId: string;
  pageNumber: number;
  ok: true;
  blocks: Array<{
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    confidence?: number;
    readingOrder: number;
    language?: string;
  }>;
  engine: string;
  engineVersion: string;
  warnings?: string[];
};

export type OcrHelperFailure = {
  protocolVersion: number;
  requestId: string;
  pageNumber?: number;
  ok: false;
  code: OcrHelperErrorCode | string;
  message?: string;
};

export type OcrHelperResponse = OcrHelperSuccess | OcrHelperFailure;

export function parseHelperResponseLine(
  line: string,
  expected: { requestId: string; pageNumber: number },
): OcrPageResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }
  const o = raw as Record<string, unknown>;
  if (o.protocolVersion !== OCR_HELPER_PROTOCOL_VERSION) {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }
  if (o.requestId !== expected.requestId) {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }
  if (o.ok === false) {
    const code =
      typeof o.code === "string" && o.code ? o.code : "OCR_HELPER_PROTOCOL_ERROR";
    throw new Error(code);
  }
  if (o.ok !== true || o.pageNumber !== expected.pageNumber) {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }
  if (!Array.isArray(o.blocks)) {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }

  const blocks: OcrBlock[] = [];
  for (const item of o.blocks) {
    if (!item || typeof item !== "object") {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    const b = item as Record<string, unknown>;
    if (typeof b.text !== "string") {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    if (b.text.length > OCR_CONFIG.maxBlockTextChars) {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    if (typeof b.readingOrder !== "number" || !Number.isFinite(b.readingOrder)) {
      throw new Error("OCR_HELPER_PROTOCOL_ERROR");
    }
    const bbox = parseNormalizedBbox(b.bbox);
    blocks.push({
      text: b.text,
      bbox,
      confidence:
        typeof b.confidence === "number" && Number.isFinite(b.confidence)
          ? b.confidence
          : undefined,
      readingOrder: b.readingOrder,
      language: typeof b.language === "string" ? b.language : undefined,
    });
  }

  blocks.sort((a, b) => a.readingOrder - b.readingOrder);
  const text = blocks.map((b) => b.text).join("\n");
  if (text.length > OCR_CONFIG.maxPageTextChars) {
    throw new Error("OCR_HELPER_PROTOCOL_ERROR");
  }

  return {
    pageNumber: expected.pageNumber,
    text,
    blocks,
    engine: typeof o.engine === "string" ? o.engine : "unknown",
    engineVersion:
      typeof o.engineVersion === "string" ? o.engineVersion : "unknown",
    warnings: Array.isArray(o.warnings)
      ? o.warnings.filter((w): w is string => typeof w === "string")
      : [],
  };
}
