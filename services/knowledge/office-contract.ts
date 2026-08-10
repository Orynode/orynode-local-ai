/**
 * Office 摄取产品契约（单一真相源）。
 *
 * 与具体转换器无关：anydoc / 其它 adapter 都遵守本契约。
 * UI、status、Job 成功后的 degraded 码均从此读取，禁止各处手抄文案。
 */

/** 与 OCR_PAGE_TRUNCATED 同模式：成功态也可写在 error_message 表示内容降级 */
export const OFFICE_SECTIONS_TRUNCATED_PREFIX = "OFFICE_SECTIONS_TRUNCATED";

export type OfficeConvertWarning = {
  code: "sections_truncated";
  kept: number;
  total: number;
};

/**
 * 本版硬约束：不物化嵌入图 bytes、不做图内 OCR、预览≠排版还原。
 * config.OFFICE_CONFIG.materializeAssets 必须保持 false。
 */
export const OFFICE_PRODUCT_CONTRACT = {
  materializeAssets: false as const,
  /**
   * Markdown 中的图片语法：只保留 alt 作检索信号，丢弃 URL / data URI / asset 引用。
   * 不把「发现过图片」写成 degraded（否则几乎每份 Word 都告警）。
   */
  imagePolicy: "alt_text_only" as const,
  /** 引用粒度：不假装 Word 物理页码 */
  citationLocus: {
    wordLike: "标题段",
    presentation: "幻灯片",
    spreadsheet: "工作表",
  },
} as const;

export function officeSectionsTruncatedCode(
  kept: number,
  total: number,
): string {
  return `${OFFICE_SECTIONS_TRUNCATED_PREFIX}:${kept}/${total}`;
}

export function officeWarningsToErrorMessage(
  warnings: readonly OfficeConvertWarning[] | undefined,
): string | null {
  const truncated = warnings?.find((w) => w.code === "sections_truncated");
  if (!truncated) return null;
  return officeSectionsTruncatedCode(truncated.kept, truncated.total);
}

export function isOfficeSectionsTruncated(
  errorCode: string | null | undefined,
): boolean {
  return Boolean(errorCode?.includes(OFFICE_SECTIONS_TRUNCATED_PREFIX));
}

export function officeSectionsTruncatedDetail(
  errorCode: string | null | undefined,
): string {
  const match = String(errorCode ?? "").match(
    new RegExp(`${OFFICE_SECTIONS_TRUNCATED_PREFIX}:(\\d+)/(\\d+)`),
  );
  if (match) {
    return `仅索引了前 ${match[1]} 个幻灯片/工作表（共 ${match[2]} 个），其余未入检索；原件仍可下载`;
  }
  return "仅索引了部分幻灯片/工作表，其余未入检索；原件仍可下载";
}

/** Office 预览横幅（与检索文本同源说明） */
export function officePreviewBanner(options?: {
  revisionId?: string | null;
}): string {
  const revisionNote =
    options?.revisionId && options.revisionId !== "legacy"
      ? "预览文本与当前入库版本一致；若文档曾重处理，引用定位可能略有偏差。\n"
      : "";
  return (
    revisionNote +
    "Office 不做排版预览，也不索引嵌入图片；下方为已转换的可检索文本（与检索/引用同源）。" +
    "需要看图或原排版时请下载原件。"
  );
}

/** 转换尚未完成时的占位说明 */
export function officePreviewPendingCopy(): string {
  return "Office 原件暂无排版预览。转换完成后可在此查看可检索文本（不含嵌入图）；也可下载原件。";
}
