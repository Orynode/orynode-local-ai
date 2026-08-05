/**
 * 内置术语种子（冷启动极小集）。
 * 开放世界同义：resolveQueryRewrite → SQLite 学习库 + LLM 晋升。
 */

export interface TerminologyEntry {
  id: string;
  terms: readonly string[];
  domain?: string;
  exclude?: readonly string[];
}

export const TERMINOLOGY_VERSION = "terminology-v4-learned";

/** 仅种子；禁止把开放世界同义堆在这里 */
export const BUILTIN_TERMINOLOGY: readonly TerminologyEntry[] = [
  {
    id: "access-token",
    terms: ["访问令牌", "訪問令牌", "access token", "access-token"],
  },
  {
    id: "reverse-proxy",
    domain: "网络代理",
    terms: ["反向代理", "reverse proxy", "reverse-proxy"],
    exclude: ["forward proxy", "正向代理", "普通代理"],
  },
  {
    id: "sodium-ion-battery",
    domain: "电池",
    terms: ["钠离子电池", "sodium-ion battery", "sodium ion battery"],
  },
] as const;
