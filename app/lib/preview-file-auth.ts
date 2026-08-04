/**
 * 原件预览服务端鉴权规则（与 Scope 自造脱钩）
 *
 * - 资料库：网关通过后，资料存在即可读
 * - 会话附件：附件 meta.conversationId 必须等于 URL 路径中的会话 id
 */

export function canReadLibraryOriginal(metaExists: boolean): boolean {
  return metaExists;
}

export function canReadConversationOriginal(input: {
  pathConversationId: string;
  metaConversationId: string | null | undefined;
}): boolean {
  const pathId = input.pathConversationId.trim();
  const metaId =
    typeof input.metaConversationId === "string"
      ? input.metaConversationId.trim()
      : "";
  return Boolean(pathId) && Boolean(metaId) && pathId === metaId;
}

/** 资料库原件网关判定（供路由与单测共用） */
export function libraryOriginalAccess(
  metaExists: boolean,
): { ok: true } | { ok: false; status: 404; error: string } {
  if (!canReadLibraryOriginal(metaExists)) {
    return { ok: false, status: 404, error: "资料不可用" };
  }
  return { ok: true };
}

/** 会话附件原件网关判定 */
export function conversationOriginalAccess(input: {
  pathConversationId: string;
  metaOk: boolean;
  metaConversationId: string | null | undefined;
}): { ok: true } | { ok: false; status: 404; error: string } {
  if (
    !input.metaOk ||
    !canReadConversationOriginal({
      pathConversationId: input.pathConversationId,
      metaConversationId: input.metaConversationId,
    })
  ) {
    return { ok: false, status: 404, error: "附件不可用" };
  }
  return { ok: true };
}

/** 从上游 bytes 响应复制预览所需响应头 */
export function copyPreviewUpstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  const contentType = upstream.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const disposition = upstream.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  const fileName = upstream.get("x-file-name");
  if (fileName) headers.set("x-file-name", fileName);
  const contentLength = upstream.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  headers.set("cache-control", "no-store");
  return headers;
}
