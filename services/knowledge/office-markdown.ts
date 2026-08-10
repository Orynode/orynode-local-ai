/**
 * Office → 规范 Markdown（转换器无关）。
 *
 * 所有 OfficeConverter adapter 在产出原始 Markdown 后必须经本模块，
 * 再进入 parseOfficeMarkdown / chunk。职责：
 * 1. PPT/表格：保证 ## Slide / ## Sheet 分段约定
 * 2. 按预算截断幻灯片/工作表，并返回 sections_truncated
 * 3. 按产品契约处理图片语法（仅留 alt）
 * 4. 输出字符硬顶
 */

import type { OfficeFormat } from "./format-registry.mjs";
import type { OfficeConvertBudget } from "./ports/office-converter";
import {
  OFFICE_PRODUCT_CONTRACT,
  type OfficeConvertWarning,
} from "./office-contract";
import { OfficeConvertError } from "./ports/office-converter";

const SLIDE_OR_SHEET_SPLIT =
  /\n(?=##\s+(?:Slide\s+\d+|Sheet:\s*))/i;
const HAS_SLIDE_OR_SHEET = /^##\s+(?:Slide\s+\d+|Sheet:)/im;

export type CanonicalOfficeMarkdown = {
  markdown: string;
  pageCountHint: number;
  warnings: OfficeConvertWarning[];
};

function isPresentation(format: OfficeFormat): boolean {
  return format === "pptx" || format === "ppt" || format === "odp";
}

function isSpreadsheet(format: OfficeFormat): boolean {
  return (
    format === "xlsx" ||
    format === "ods" ||
    format === "csv"
  );
}

/**
 * Markdown 图片 → 纯文本 alt（丢弃 URL / data URI）。
 * 无 alt 时省略，避免向索引灌入噪声。
 */
export function applyOfficeImagePolicy(markdown: string): string {
  if (OFFICE_PRODUCT_CONTRACT.imagePolicy !== "alt_text_only") {
    return markdown;
  }
  return markdown.replace(
    /!\[([^\]]*)\]\([^)]*\)/g,
    (_full, alt: string) => {
      const text = String(alt ?? "").trim();
      return text ? text : "";
    },
  );
}

function ensureSectionHeaders(
  markdown: string,
  format: OfficeFormat,
): string {
  const trimmed = markdown.trim();
  if (!trimmed) return trimmed;
  if (isPresentation(format) && !HAS_SLIDE_OR_SHEET.test(trimmed)) {
    return `## Slide 1\n\n${trimmed}`;
  }
  if (isSpreadsheet(format) && !HAS_SLIDE_OR_SHEET.test(trimmed)) {
    return `## Sheet: Sheet1\n\n${trimmed}`;
  }
  return trimmed;
}

function splitOfficeSections(markdown: string): string[] {
  if (!HAS_SLIDE_OR_SHEET.test(markdown)) {
    return [markdown];
  }
  return markdown
    .split(SLIDE_OR_SHEET_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function countPageHint(markdown: string, format: OfficeFormat): number {
  const sections = splitOfficeSections(markdown);
  if (
    (isPresentation(format) || isSpreadsheet(format)) &&
    sections.length > 0
  ) {
    return Math.max(1, sections.length);
  }
  const headings = markdown.match(/^#{1,3}\s+/gm);
  return Math.max(1, headings?.length ?? 1);
}

/**
 * 将任意 converter 的 Markdown 规范为入库约定形态。
 */
export function canonicalizeOfficeMarkdown(
  rawMarkdown: string,
  format: OfficeFormat,
  budget: Pick<OfficeConvertBudget, "maxOutputChars" | "maxSlidesOrSheets">,
): CanonicalOfficeMarkdown {
  const warnings: OfficeConvertWarning[] = [];
  let markdown = applyOfficeImagePolicy(
    ensureSectionHeaders(String(rawMarkdown ?? ""), format),
  );

  if (!markdown.trim()) {
    throw new OfficeConvertError("Malformed", "转换结果为空");
  }

  if (isPresentation(format) || isSpreadsheet(format)) {
    const sections = splitOfficeSections(markdown);
    const total = sections.length;
    const kept = Math.min(total, budget.maxSlidesOrSheets);
    if (kept < total) {
      markdown = sections.slice(0, kept).join("\n\n").trim();
      warnings.push({ code: "sections_truncated", kept, total });
    } else {
      markdown = sections.join("\n\n").trim();
    }
  }

  if (markdown.length > budget.maxOutputChars) {
    throw new OfficeConvertError(
      "OutputTooLarge",
      `转换输出超过 ${budget.maxOutputChars} 字符`,
    );
  }

  return {
    markdown,
    pageCountHint: countPageHint(markdown, format),
    warnings,
  };
}
