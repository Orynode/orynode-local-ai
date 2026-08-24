/**
 * API 错误响应统一脱敏
 *
 * 原则：未知异常一律回传语义化兜底文案，完整错误仅进服务端日志。
 * 已知业务错误（带 code 或命中白名单文案）原样透传，保证前端可用性。
 */

type SanitizedError = {
  message: string;
  status?: number;
};

/** 允许透传给客户端的业务错误片段（均为服务端主动抛出的用户可读文案） */
const SAFE_MESSAGE_PATTERNS: RegExp[] = [
  /^OCR_DISABLED$/,
  /只支持/, // 格式不支持提示
  /不能为空|不能超过|必填/,
  /不存在$/, // 对话/文档/来源不存在（404 类）
  /对话不存在/,
  /没有可提取|扫描版/, // PDF 内容提取类提示
  /尚未启动|正在重建向量/, // 服务未就绪提示
  /文件名过长|重命名后重试/,
];

function isSafeMessage(message: string): boolean {
  return SAFE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 提取可安全回显的错误信息；不安全时返回 null（调用方用 fallback 文案）。
 */
export function sanitizeErrorMessage(
  error: unknown,
): SanitizedError | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  if (!message || !isSafeMessage(message)) return null;
  return { message };
}

/**
 * 统一的 catch 块出口：日志收全量、响应给语义化文案。
 *
 * @example
 * catch (error) {
 *   return sanitizedErrorResponse(error, "检索失败", { status: 502, code: "retrieval_failed" });
 * }
 */
export function sanitizedErrorResponse(
  error: unknown,
  fallback: string,
  options?: {
    status?: number;
    code?: string;
    logTag?: string;
    /** 已知安全文案按此状态返回（如校验错误 400），其余用 status */
    safeStatus?: number;
  },
): Response {
  const tag = options?.logTag ?? "[api]";
  console.error(`${tag} error:`, error);
  const sanitized = sanitizeErrorMessage(error);
  const body: Record<string, string> = {
    error: sanitized?.message ?? fallback,
  };
  if (options?.code) body.code = options.code;
  return Response.json(body, {
    status: (sanitized ? options?.safeStatus : undefined) ?? options?.status ?? 502,
  });
}
