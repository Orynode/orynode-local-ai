/** 面向用户的预览错误文案（隐藏 worker/堆栈等实现细节） */

export function friendlyPreviewLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (/无权|不可用|不存在|404/i.test(raw)) {
    return "无法打开原件：文件不存在或当前无权访问。";
  }
  if (/Failed to fetch|NetworkError|network|ECONNREFUSED|timeout/i.test(raw)) {
    return "无法连接本地资料服务，请确认应用与 data-service 已启动后重试。";
  }
  if (raw && raw.length <= 80 && !/at\s+\S+|webpack|vite/i.test(raw)) {
    return raw;
  }
  return "打开原件失败，请稍后重试。";
}

export function friendlyPdfError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (!raw || /cancel/i.test(raw)) return "";
  if (
    /Invalid PDF|Missing PDF|FormatError|password|encrypted/i.test(raw)
  ) {
    return "无法解析该 PDF（可能已损坏或受密码保护），请下载后用本地阅读器打开。";
  }
  if (
    /pdf\.worker|Dynamically imported module|Failed to fetch|NetworkError|worker/i.test(
      raw,
    )
  ) {
    return "PDF 渲染组件加载失败，请刷新页面后重试，或下载原件本地打开。";
  }
  if (raw.length <= 100 && !/at\s+\S+|webpack|vite/i.test(raw)) {
    return `PDF 预览失败：${raw}`;
  }
  return "PDF 预览失败，请稍后重试或下载原件。";
}
