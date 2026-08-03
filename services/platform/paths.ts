/**
 * 平台中立存储键规范化（导出包与跨平台迁移）
 *
 * 禁止把绝对路径写入导出清单；Windows 保留名与危险字符在入库前净化。
 */

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "lpt1",
  "lpt2",
  "lpt3",
]);

/** 把任意路径规范为 POSIX 风格相对 storage key */
export function toStorageKey(input: string): string {
  const normalized = input
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]:)?\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  const parts = normalized.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.join("/");
}

/** 导出/显示用文件名净化（保留扩展名） */
export function sanitizeFileName(name: string, fallback = "document"): string {
  const trimmed = name.trim() || fallback;
  const base = trimmed.replace(/[<>:"|?*\u0000-\u001f]/g, "_");
  const noDots = base.replace(/^\.+/, "") || fallback;
  const stem = noDots.includes(".")
    ? noDots.slice(0, noDots.lastIndexOf("."))
    : noDots;
  const ext = noDots.includes(".")
    ? noDots.slice(noDots.lastIndexOf("."))
    : "";
  const lower = stem.toLowerCase();
  const safeStem = WINDOWS_RESERVED.has(lower) ? `_${stem}` : stem;
  const joined = `${safeStem}${ext}`.slice(0, 180);
  return joined || fallback;
}

/** 检测是否像 Windows 绝对路径（契约测试用，不依赖本机 OS） */
export function looksLikeWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function assertRelativeStorageKey(key: string): void {
  if (!key || key.startsWith("/") || looksLikeWindowsAbsolutePath(key)) {
    throw new Error(`storage key 必须是相对路径: ${key}`);
  }
  if (key.includes("..")) {
    throw new Error(`storage key 不得包含 ..: ${key}`);
  }
}
