/**
 * PDF 页面文本质量判定（KE-027）
 *
 * 禁止无条件 OCR：usable → native；真空白 → blank；疑似扫描 → ocr。
 */

import { OCR_CONFIG } from "../../../config/defaults";

export type PageTextDecision = "native" | "blank" | "ocr";

export type PageTextQuality = {
  pageNumber: number;
  extractedCharacters: number;
  meaningfulCharacters: number;
  replacementCharacterRatio: number;
  hasLargeRasterImage: boolean;
  decision: PageTextDecision;
  reason: string;
};

export type PageQualityInput = {
  pageNumber: number;
  text: string;
  hasLargeRasterImage?: boolean;
  config?: Partial<typeof OCR_CONFIG>;
};

function countMeaningful(text: string): {
  extracted: number;
  meaningful: number;
  replacementRatio: number;
} {
  const extracted = text.length;
  if (extracted === 0) {
    return { extracted: 0, meaningful: 0, replacementRatio: 0 };
  }
  let replacement = 0;
  let meaningful = 0;
  for (const ch of text) {
    if (ch === "\uFFFD") {
      replacement += 1;
      continue;
    }
    if (/\s/.test(ch)) continue;
    // 字母、数字、CJK、常见标点算有意义
    if (/[\p{L}\p{N}\u4e00-\u9fff]/u.test(ch) || /[.,;:!?，。；：！？、]/.test(ch)) {
      meaningful += 1;
    }
  }
  return {
    extracted,
    meaningful,
    replacementRatio: replacement / extracted,
  };
}

export function assessPageTextQuality(input: PageQualityInput): PageTextQuality {
  const cfg = { ...OCR_CONFIG, ...input.config };
  const hasLargeRasterImage = Boolean(input.hasLargeRasterImage);
  const stats = countMeaningful(input.text ?? "");

  if (stats.extracted === 0 && !hasLargeRasterImage) {
    return {
      pageNumber: input.pageNumber,
      extractedCharacters: 0,
      meaningfulCharacters: 0,
      replacementCharacterRatio: 0,
      hasLargeRasterImage,
      decision: "blank",
      reason: "empty_text_no_raster",
    };
  }

  if (stats.extracted === 0 && hasLargeRasterImage) {
    return {
      pageNumber: input.pageNumber,
      extractedCharacters: 0,
      meaningfulCharacters: 0,
      replacementCharacterRatio: 0,
      hasLargeRasterImage,
      decision: "ocr",
      reason: "raster_without_text",
    };
  }

  if (stats.replacementRatio > cfg.maxReplacementCharacterRatio) {
    return {
      pageNumber: input.pageNumber,
      extractedCharacters: stats.extracted,
      meaningfulCharacters: stats.meaningful,
      replacementCharacterRatio: stats.replacementRatio,
      hasLargeRasterImage,
      decision: "ocr",
      reason: "high_replacement_ratio",
    };
  }

  if (stats.meaningful < cfg.minMeaningfulCharacters) {
    if (hasLargeRasterImage) {
      return {
        pageNumber: input.pageNumber,
        extractedCharacters: stats.extracted,
        meaningfulCharacters: stats.meaningful,
        replacementCharacterRatio: stats.replacementRatio,
        hasLargeRasterImage,
        decision: "ocr",
        reason: "sparse_text_with_raster",
      };
    }
    return {
      pageNumber: input.pageNumber,
      extractedCharacters: stats.extracted,
      meaningfulCharacters: stats.meaningful,
      replacementCharacterRatio: stats.replacementRatio,
      hasLargeRasterImage,
      decision: "blank",
      reason: "sparse_text_no_raster",
    };
  }

  return {
    pageNumber: input.pageNumber,
    extractedCharacters: stats.extracted,
    meaningfulCharacters: stats.meaningful,
    replacementCharacterRatio: stats.replacementRatio,
    hasLargeRasterImage,
    decision: "native",
    reason: "usable_native_text",
  };
}

export function summarizePageQualities(pages: PageTextQuality[]): {
  needsOcr: boolean;
  ocrPageCount: number;
  nativePageCount: number;
  blankPageCount: number;
} {
  let ocrPageCount = 0;
  let nativePageCount = 0;
  let blankPageCount = 0;
  for (const p of pages) {
    if (p.decision === "ocr") ocrPageCount += 1;
    else if (p.decision === "native") nativePageCount += 1;
    else blankPageCount += 1;
  }
  return {
    needsOcr: ocrPageCount > 0,
    ocrPageCount,
    nativePageCount,
    blankPageCount,
  };
}
