export interface MobileAttachmentRemovalRequest {
  path: string;
  init: {
    method: "DELETE";
    headers: Record<string, string>;
    keepalive?: boolean;
  };
}

export function mobileAttachmentRemovalRequest(
  sessionId: string,
  id: string,
  csrfToken: string,
  keepalive = false,
): MobileAttachmentRemovalRequest {
  return {
    path: `/api/attachments/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`,
    init: {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
      ...(keepalive ? { keepalive: true } : {}),
    },
  };
}
