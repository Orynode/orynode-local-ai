/**
 * 稳定降级原因码 → 普通用户可读文案（不解析服务端自然语言）
 */

const DEGRADED_REASON_LABELS: Record<string, string> = {
  SEMANTIC_SEARCH_DISABLED: "未开启语义搜索，当前仅用关键词",
  SEMANTIC_RUNTIME_UNAVAILABLE: "语义模型未就绪，已回退关键词",
  VECTOR_INDEX_NOT_READY: "向量索引未就绪，已回退关键词",
  RERANKER_UNAVAILABLE: "重排能力不可用，已跳过词法重排",
  RESOURCE_PRESSURE: "资源紧张，已自动降档",
  QUALITY_RETRIEVAL_UNAVAILABLE: "更高质量档不可用，已降级",
  MULTILINGUAL_VECTOR_UNAVAILABLE: "多语言向量不可用，已弱化语义路",
  FTS_AND_EMPTY_OR_FALLBACK: "关键词精确组合无命中，已按覆盖率放宽（旧码）",
  FTS_MINIMUM_MATCH: "关键词未全中，已按最低覆盖率放宽",
  LEGACY_INDEX_ACTIVE: "正在使用旧版关键词索引",
  EMBED_DEFERRED_CHAT: "对话占用中，向量任务已推迟",
  empty_scope: "未选择资料范围",
  vector: "语义召回不可用",
};

/** 将稳定码格式化为短中文说明；未知码原样返回 */
export function formatDegradedReason(code: string): string {
  const key = String(code ?? "").trim();
  if (!key) return "";
  return DEGRADED_REASON_LABELS[key] ?? key;
}

/** 去重后的可读列表；空输入返回 [] */
export function formatDegradedReasons(
  codes: Iterable<string> | null | undefined,
): string[] {
  if (!codes) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const label = formatDegradedReason(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** 单行摘要，供搜索栏 / 消息旁提示 */
export function summarizeDegradedReasons(
  codes: Iterable<string> | null | undefined,
  maxItems = 2,
): string {
  const labels = formatDegradedReasons(codes);
  if (labels.length === 0) return "";
  if (labels.length <= maxItems) return labels.join("；");
  return `${labels.slice(0, maxItems).join("；")}等 ${labels.length} 项`;
}
