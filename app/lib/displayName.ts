/**
 * 本机对话显示名（侧栏 / 气泡 / 设置共用）
 */

export const DEFAULT_DISPLAY_NAME = "碳基生物";
export const DISPLAY_NAME_KEY = "orynode.displayName";

export function readStoredDisplayName(): string {
  try {
    return (
      window.localStorage.getItem(DISPLAY_NAME_KEY)?.trim() ||
      DEFAULT_DISPLAY_NAME
    );
  } catch {
    return DEFAULT_DISPLAY_NAME;
  }
}

export function persistDisplayName(value: string): string {
  const next = value.trim() || DEFAULT_DISPLAY_NAME;
  try {
    window.localStorage.setItem(DISPLAY_NAME_KEY, next);
  } catch {
    // ignore quota / private mode
  }
  return next;
}
