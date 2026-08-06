/**
 * 查询类型判断：精确类查询跳过 Quality 多查询扩展，避免噪声与延迟。
 */

export type QueryKind =
  | "exact_phrase"
  | "filename"
  | "error_code"
  | "symbol"
  | "general";

const FILE_EXT =
  /\.(pdf|md|markdown|txt|docx?|xlsx?|pptx?|csv|json|ya?ml|xml|html?|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cpp|h|hpp|cs|rb|php|sql|sh|zsh|toml|ini|cfg|log)$/i;

const ERROR_CODE =
  /^(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*|[A-Z]{2,}[-_]?\d{2,}|\d{3}\s+[A-Z][A-Za-z ]+)$/;

const SYMBOL =
  /^(?:[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+(?:\(\))?|[A-Za-z_][\w]*\(\)|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z]+(?:_[A-Z0-9]+)+)$/;

/**
 * 识别查询是否属于「精确检索」类（文件名、错误码、符号、引号短语）。
 */
export function detectQueryKind(query: string): QueryKind {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return "general";

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 2) ||
    (trimmed.startsWith("「") && trimmed.endsWith("」") && trimmed.length > 2)
  ) {
    return "exact_phrase";
  }

  const bare = trimmed.replace(/^["'`「]|["'`」]$/g, "");
  // 扩展名判定必须像「文件名/路径」，禁止「how to install node.js」因句尾 .js 误判
  const looksLikeFilename =
    FILE_EXT.test(bare) && (!/\s/.test(bare) || /[/\\]/.test(bare));
  if (looksLikeFilename) {
    return "filename";
  }

  if (ERROR_CODE.test(bare) || /^error\s*[:：]/i.test(trimmed)) {
    return "error_code";
  }

  // 单 token 标识符 / 限定名
  if (!/\s/.test(bare) && (SYMBOL.test(bare) || /^`[^`]+`$/.test(trimmed))) {
    return "symbol";
  }

  return "general";
}

/** Quality 档是否应对该查询生成变体 */
export function shouldExpandQuery(query: string): boolean {
  return detectQueryKind(query) === "general";
}
