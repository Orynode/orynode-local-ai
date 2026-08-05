/**
 * 多语言关键词字段构造（ML-004）
 * content 永不改写；派生字段由 normalizerVersion / analyzerVersion 标识。
 */

import { extractTechnicalTerms } from "../retrieval/keyword";

export const NORMALIZER_VERSION = "ml-normalizer-v2";
export const ANALYZER_VERSION = "fts5-multilingual-v1";
export const KEYWORD_V2_BUILD_ID = "keyword-fts-v2-global";

/** 简→繁 高置信常用映射（IT/RAG 场景；非完整 OpenCC） */
const S2T: Record<string, string> = {
  国: "國",
  们: "們",
  过: "過",
  来: "來",
  时: "時",
  么: "麼",
  对: "對",
  东: "東",
  车: "車",
  门: "門",
  开: "開",
  关: "關",
  为: "爲",
  说: "說",
  与: "與",
  学: "學",
  发: "發",
  经: "經",
  总: "總",
  体: "體",
  实: "實",
  际: "際",
  现: "現",
  应: "應",
  会: "會",
  语: "語",
  库: "庫",
  检: "檢",
  索: "索",
  档: "檔",
  标: "標",
  题: "題",
  认: "認",
  证: "證",
  访: "訪",
  问: "問",
  识: "識",
  资: "資",
  传: "傳",
  数: "數",
  据: "據",
  请: "請",
  写: "寫",
  机: "機",
  设: "設",
  备: "備",
  处: "處",
  运: "運",
  启: "啟",
  动: "動",
  务: "務",
  网: "網",
  络: "絡",
  连: "連",
  错: "錯",
  误: "誤",
  败: "敗",
  环: "環",
  变: "變",
  权: "權",
  缓: "緩",
  览: "覽",
  页: "頁",
  预: "預",
  话: "話",
  户: "戶",
  码: "碼",
  隐: "隱",
  云: "雲",
  节: "節",
  内: "內",
  结: "結",
  询: "詢",
  选: "選",
  级: "級",
  闭: "閉",
  装: "裝",
  赖: "賴",
  滚: "滾",
  复: "復",
  删: "刪",
  创: "創",
  导: "導",
  别: "別",
  扫: "掃",
  图: "圖",
  优: "優",
  仅: "僅",
  载: "載",
  输: "輸",
  块: "塊",
};

const T2S: Record<string, string> = Object.fromEntries(
  Object.entries(S2T).map(([s, t]) => [t, s]),
);

export type MultilingualFields = {
  exactText: string;
  zhText: string;
  enText: string;
  mixedText: string;
  normalizerVersion: string;
  analyzerVersion: string;
};

function nfcLower(text: string): string {
  return String(text ?? "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function expandHansHant(text: string): string {
  const toT = [...text].map((ch) => S2T[ch] ?? ch).join("");
  const toS = [...text].map((ch) => T2S[ch] ?? ch).join("");
  const parts = new Set<string>([text]);
  if (toT !== text) parts.add(toT);
  if (toS !== text) parts.add(toS);
  return [...parts].join(" ");
}

/** 查询词简繁变体（用于 FTS：同义用 OR，避免 AND 强制双形） */
export function hansHantVariants(term: string): string[] {
  const raw = String(term ?? "").trim();
  if (!raw) return [];
  const expanded = expandHansHant(raw)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set(expanded)];
}

function buildZhText(normalized: string): string {
  const extras: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    const expanded = expandHansHant(run);
    extras.push(expanded);
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      extras.push(bigram);
      extras.push(expandHansHant(bigram));
    }
  }
  return extras.length > 0 ? extras.join(" ") : "";
}

function buildEnText(normalized: string): string {
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/[\p{Script=Han}]/u.test(token)) continue;
    if (token.length >= 2) tokens.push(token);
  }
  return tokens.join(" ");
}

function buildExactText(normalized: string, original: string): string {
  const parts = new Set<string>();
  for (const tech of extractTechnicalTerms(normalized)) {
    parts.add(tech);
  }
  // 保留大小写折叠后的原片段中的路径 / 扩展名
  for (const match of original.matchAll(
    /[A-Za-z0-9_.\-/\\]+\.(?:pdf|md|txt|docx?|tsx?|jsx?|py|go|rs|json)/gi,
  )) {
    parts.add(match[0].toLocaleLowerCase());
  }
  for (const match of normalized.matchAll(
    /\b(?:err_[a-z0-9_]+|e[a-z]{2,}[a-z0-9_]*)\b/g,
  )) {
    parts.add(match[0]);
  }
  return [...parts].join(" ");
}

/**
 * 从原文构造 FTS v2 多字段；不改写 content。
 */
export function buildMultilingualFields(content: string): MultilingualFields {
  const original = String(content ?? "");
  const normalized = nfcLower(original);
  if (!normalized) {
    return {
      exactText: "",
      zhText: "",
      enText: "",
      mixedText: "",
      normalizerVersion: NORMALIZER_VERSION,
      analyzerVersion: ANALYZER_VERSION,
    };
  }

  const exactText = buildExactText(normalized, original);
  const zhText = buildZhText(normalized);
  const enText = buildEnText(normalized);
  const tech = extractTechnicalTerms(normalized).join(" ");
  const mixedText = [normalized, tech].filter(Boolean).join(" ");

  return {
    exactText,
    zhText,
    enText,
    mixedText,
    normalizerVersion: NORMALIZER_VERSION,
    analyzerVersion: ANALYZER_VERSION,
  };
}
