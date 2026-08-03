/**
 * LanguageProfile — 轻量脚本比例识别（ML-002）
 * 不加载独立语言模型；mixed / undetermined 为一等状态。
 */

export type LanguageTag =
  | "zh-Hans"
  | "zh-Hant"
  | "en"
  | "mixed"
  | "undetermined";

export interface LanguageSignal {
  tag: LanguageTag;
  confidence: number;
  share?: number;
}

export interface LanguageProfile {
  primary: LanguageTag;
  signals: LanguageSignal[];
  hasHan: boolean;
  hasLatin: boolean;
  hasTechnicalTerms: boolean;
  normalizedQuery: string;
}

/** 常见繁体字特征（轻量启发式，非完整 OpenCC） */
const HANT_CHARS =
  /[國們過來時麼對東車門開關爲說與學發經總體實際現應會語資訊]/u;

export function analyzeLanguage(text: string): LanguageProfile {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return {
      primary: "undetermined",
      signals: [{ tag: "undetermined", confidence: 1, share: 1 }],
      hasHan: false,
      hasLatin: false,
      hasTechnicalTerms: false,
      normalizedQuery: "",
    };
  }

  let han = 0;
  let latin = 0;
  let other = 0;
  let hantHits = 0;

  for (const ch of normalized) {
    if (/[\p{Script=Han}]/u.test(ch)) {
      han += 1;
      if (HANT_CHARS.test(ch)) hantHits += 1;
    } else if (/[\p{Script=Latin}]/u.test(ch)) {
      latin += 1;
    } else if (/\S/u.test(ch)) {
      other += 1;
    }
  }

  const total = Math.max(han + latin + other, 1);
  const hanShare = han / total;
  const latinShare = latin / total;
  const hasHan = han > 0;
  const hasLatin = latin > 0;
  const hasTechnicalTerms =
    /\b(?:c\+\+|c#|\.net|node\.js|[\w]+(?:\.[\w]+)+|[\w]+(?:-[\w]+)+)\b/i.test(
      normalized,
    ) || /[/\\][\w./-]+/.test(normalized);

  const signals: LanguageSignal[] = [];
  let primary: LanguageTag = "undetermined";

  if (hanShare >= 0.55 && latinShare < 0.2) {
    primary = hantHits >= 2 ? "zh-Hant" : "zh-Hans";
    signals.push({
      tag: primary,
      confidence: Math.min(0.95, 0.55 + hanShare * 0.4),
      share: hanShare,
    });
  } else if (latinShare >= 0.55 && hanShare < 0.15) {
    primary = "en";
    signals.push({
      tag: "en",
      confidence: Math.min(0.95, 0.55 + latinShare * 0.4),
      share: latinShare,
    });
  } else if (hasHan && hasLatin) {
    primary = "mixed";
    signals.push(
      { tag: "mixed", confidence: 0.7, share: hanShare + latinShare },
      { tag: "zh-Hans", confidence: hanShare, share: hanShare },
      { tag: "en", confidence: latinShare, share: latinShare },
    );
  } else if (hasHan) {
    primary = hantHits >= 1 ? "zh-Hant" : "zh-Hans";
    signals.push({ tag: primary, confidence: 0.6, share: hanShare });
  } else if (hasLatin) {
    primary = "en";
    signals.push({ tag: "en", confidence: 0.6, share: latinShare });
  } else {
    signals.push({ tag: "undetermined", confidence: 0.5, share: 1 });
  }

  return {
    primary,
    signals,
    hasHan,
    hasLatin,
    hasTechnicalTerms,
    normalizedQuery: normalized.toLocaleLowerCase(),
  };
}

export interface LanguageAnalyzerPort {
  analyze(text: string): Promise<LanguageProfile>;
}

export class RuleLanguageAnalyzer implements LanguageAnalyzerPort {
  async analyze(text: string): Promise<LanguageProfile> {
    return analyzeLanguage(text);
  }
}
