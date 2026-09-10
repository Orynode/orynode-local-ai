/**
 * 中文功能形态：只在 MATCH 清洗时剥，不进 extractSearchTerms。
 * 与拉丁功能词对称——低信息 bigram 在抽取层只降权，在 general 阶梯才从 MATCH 词表去掉。
 */

import { ZH_LOW_INFO_BIGRAMS } from "../retrieval/keyword";

/** 句尾/句首结构助词；不单独作为 MATCH 必中项 */
const ZH_FUNCTION_CHARS = new Set([
  "是",
  "的",
  "了",
  "吗",
  "呢",
  "吧",
  "啊",
  "嘛",
  "着",
  "过",
  "得",
  "地",
  "么",
  "啥",
  "呀",
]);

export function isZhLowInfoMatchTerm(term: string): boolean {
  return ZH_LOW_INFO_BIGRAMS.has(String(term ?? "").trim());
}

function markZhLowInfoChars(run: string): boolean[] {
  const skip = Array.from({ length: run.length }, () => false);
  for (let i = 0; i < run.length - 1; i += 1) {
    if (ZH_LOW_INFO_BIGRAMS.has(run.slice(i, i + 2))) {
      skip[i] = true;
      skip[i + 1] = true;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < run.length; i += 1) {
      if (skip[i] || !ZH_FUNCTION_CHARS.has(run[i]!)) continue;
      const adjacent =
        (i > 0 && skip[i - 1]) || (i + 1 < run.length && skip[i + 1]);
      if (adjacent) {
        skip[i] = true;
        changed = true;
      }
    }
  }
  return skip;
}

/**
 * 从连续汉字里取出最长内容核：低信息 bigram 切开，再剥贴在切口上的助词。
 * 「内存池是什么」→「内存池」；「什么是冰块」→「冰块」。
 */
export function peelZhFunctionAffixes(term: string): string {
  const raw = String(term ?? "").trim();
  if (!raw) return "";
  if (!/^[\p{Script=Han}]+$/u.test(raw)) return raw;
  const skip = markZhLowInfoChars(raw);
  let best = "";
  let i = 0;
  while (i < raw.length) {
    if (skip[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < raw.length && !skip[j]) j += 1;
    let span = raw.slice(i, j);
    while (span.length > 0 && ZH_FUNCTION_CHARS.has(span[0]!)) {
      span = span.slice(1);
    }
    while (
      span.length > 0 &&
      ZH_FUNCTION_CHARS.has(span[span.length - 1]!)
    ) {
      span = span.slice(0, -1);
    }
    if (span.length > best.length) best = span;
    i = j;
  }
  return best.length >= 2 ? best : "";
}

export function hanTermHasFunctionChar(term: string): boolean {
  return [...String(term ?? "")].some((char) => ZH_FUNCTION_CHARS.has(char));
}
