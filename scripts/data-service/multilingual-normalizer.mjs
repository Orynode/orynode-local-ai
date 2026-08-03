/**
 * 多语言关键词字段构造（与 services/knowledge/indexing/multilingual-normalizer.ts 对齐）
 */

import { extractTechnicalTerms } from "./search-text.mjs";

export const NORMALIZER_VERSION = "ml-normalizer-v1";
export const ANALYZER_VERSION = "fts5-multilingual-v1";
/** 全局 keyword v2 build 标记（单库单 active 物理索引；rollback 切回 v1） */
export const KEYWORD_V2_BUILD_ID = "keyword-fts-v2-global";

const S2T = {
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
  信: "信",
  息: "息",
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
  令: "令",
  牌: "牌",
  向: "向",
  量: "量",
  引: "引",
  擎: "擎",
  知: "知",
  识: "識",
  资: "資",
  传: "傳",
  数: "數",
  据: "據",
  请: "請",
  建: "建",
  写: "寫",
  入: "入",
  机: "機",
  设: "設",
};

const T2S = Object.fromEntries(
  Object.entries(S2T).map(([s, t]) => [t, s]),
);

function nfcLower(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function expandHansHant(text) {
  const toT = [...text].map((ch) => S2T[ch] ?? ch).join("");
  const toS = [...text].map((ch) => T2S[ch] ?? ch).join("");
  const parts = new Set([text]);
  if (toT !== text) parts.add(toT);
  if (toS !== text) parts.add(toS);
  return [...parts].join(" ");
}

function buildZhText(normalized) {
  const extras = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    extras.push(expandHansHant(run));
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      extras.push(bigram);
      extras.push(expandHansHant(bigram));
    }
  }
  return extras.length > 0 ? extras.join(" ") : "";
}

function buildEnText(normalized) {
  const tokens = [];
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/[\p{Script=Han}]/u.test(token)) continue;
    if (token.length >= 2) tokens.push(token);
  }
  return tokens.join(" ");
}

function buildExactText(normalized, original) {
  const parts = new Set();
  for (const tech of extractTechnicalTerms(normalized)) {
    parts.add(tech);
  }
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
 * @param {string} content
 */
export function buildMultilingualFields(content) {
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
