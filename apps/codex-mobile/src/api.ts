import type {
  MobileAccountAction, MobileAccountsSnapshot, MobileActivity, MobileApproval, MobileAttachment, MobileCapabilities, MobileDevice, MobileElicitation, MobileElicitationAction, MobileFile, MobileFileListing, MobileGitConflictStages, MobileGitDiff, MobileGitStatus, MobileHistory, MobileOperation, MobileSnapshot,
} from "./types.js";

export class MobileApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MobileApiError";
  }
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { error?: unknown } & T;
  if (!response.ok) {
    throw new MobileApiError(typeof payload.error === "string" ? payload.error : `Ошибка сервера (${response.status})`, response.status);
  }
  return payload;
}

export function readSession() {
  return jsonRequest<{ device: MobileDevice; csrfToken: string }>("/api/session");
}

export function beginPairing(deviceName: string) {
  return jsonRequest<{ pairingId: string; code: string; expiresAt: number }>("/api/pairing/start", {
    method: "POST", body: JSON.stringify({ deviceName }),
  });
}

export function pairingStatus() {
  return jsonRequest<{ status: "pending" | "approved"; csrfToken?: string; device?: MobileDevice }>("/api/pairing/status");
}

export function readSnapshot() {
  return jsonRequest<MobileSnapshot>("/api/snapshot");
}

export function readAccounts() {
  return jsonRequest<MobileAccountsSnapshot>("/api/accounts");
}

export function manageAccount(action: MobileAccountAction, csrfToken: string) {
  return jsonRequest<{ snapshot: MobileAccountsSnapshot; message?: string }>("/api/accounts", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify(action),
  });
}

export function readCapabilities(sessionId: string, section = "core") {
  const query = new URLSearchParams({ sessionId, section });
  return jsonRequest<MobileCapabilities>(`/api/capabilities?${query}`);
}

export function readSkillInventory(sessionId: string) {
  const query = new URLSearchParams({ sessionId, section: "skills" });
  return jsonRequest<{ skills: MobileCapabilities["skills"] }>(`/api/capabilities?${query}`);
}

export function readAppInventory(sessionId: string) {
  const query = new URLSearchParams({ sessionId, section: "apps" });
  return jsonRequest<Pick<MobileCapabilities, "apps" | "appsAvailable">>(`/api/capabilities?${query}`);
}

export function readPluginInventory(sessionId: string) {
  const query = new URLSearchParams({ sessionId, section: "plugins" });
  return jsonRequest<Pick<MobileCapabilities, "plugins" | "pluginCatalogAvailable" | "marketplaces">>(`/api/capabilities?${query}`);
}

export function readMcpInventory(sessionId: string) {
  const query = new URLSearchParams({ sessionId, section: "mcp" });
  return jsonRequest<Pick<MobileCapabilities, "mcpServers" | "mcpServersAvailable">>(`/api/capabilities?${query}`);
}

export function readApprovals(sessionId: string) {
  return jsonRequest<{ approvals: MobileApproval[] }>(`/api/approvals?sessionId=${encodeURIComponent(sessionId)}`);
}

export function readElicitations(sessionId: string) {
  return jsonRequest<{ elicitations: MobileElicitation[] }>(`/api/elicitations?sessionId=${encodeURIComponent(sessionId)}`);
}

export function readFileListing(sessionId: string, path: string, offset?: number) {
  const query = new URLSearchParams({ sessionId, path });
  if (offset !== undefined) query.set("offset", String(offset));
  return jsonRequest<MobileFileListing>(`/api/files?${query}`);
}

export function readProjectFile(sessionId: string, path: string) {
  const query = new URLSearchParams({ sessionId, path });
  return jsonRequest<MobileFile>(`/api/file?${query}`);
}

export async function downloadProjectFile(sessionId: string, path: string): Promise<void> {
  const query = new URLSearchParams({ sessionId, path });
  const response = await fetch(`/api/file-download?${query}`, {
    credentials: "same-origin", cache: "no-store", redirect: "error",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    throw new MobileApiError(typeof payload.error === "string" ? payload.error : `Не удалось скачать файл (${response.status})`, response.status);
  }
  if (response.headers.get("content-type") !== "application/octet-stream") {
    throw new MobileApiError("Сервер вернул неподдерживаемый формат файла", 415);
  }
  const bytes = await response.blob();
  if (bytes.size > 10 * 1024 * 1024) throw new MobileApiError("Файл больше 10 МБ", 413);
  const segments = path.replaceAll("\\", "/").split("/");
  const filename = segments.at(-1) || "download";
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

export function readGitStatus(sessionId: string) {
  return jsonRequest<MobileGitStatus>(`/api/git/status?sessionId=${encodeURIComponent(sessionId)}`);
}

export function readGitDiff(sessionId: string, path?: string, previousPath?: string) {
  const query = new URLSearchParams({ sessionId });
  if (path !== undefined) query.set("path", path);
  if (previousPath !== undefined) query.set("previousPath", previousPath);
  return jsonRequest<MobileGitDiff>(`/api/git/diff?${query}`);
}

export function readGitConflictStages(sessionId: string, path: string) {
  const query = new URLSearchParams({ sessionId, path });
  return jsonRequest<MobileGitConflictStages>(`/api/git/conflict-stages?${query}`);
}

export function resolveApproval(id: string, sessionId: string, optionId: string, csrfToken: string) {
  return jsonRequest<{ resolved: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ sessionId, optionId }),
  });
}

export function resolveElicitation(
  id: string,
  sessionId: string,
  action: MobileElicitationAction,
  content: Record<string, unknown> | undefined,
  csrfToken: string,
) {
  return jsonRequest<{ resolved: boolean }>(`/api/elicitations/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ sessionId, action, ...(content ? { content } : {}) }),
  });
}

export function readHistory(sessionId: string, includeTools: boolean) {
  const query = includeTools ? "?tools=true" : "";
  return jsonRequest<MobileHistory>(`/api/history/${encodeURIComponent(sessionId)}${query}`);
}

export function readActivity(sessionId: string) {
  return jsonRequest<MobileActivity>(`/api/activity/${encodeURIComponent(sessionId)}`);
}

export function imageUrl(sessionId: string, path: string): string {
  const url = new URL("/api/image", window.location.origin);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("path", path);
  return url.toString();
}

export function projectImageUrl(sessionId: string, path: string): string {
  const url = new URL("/api/project-image", window.location.origin);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("path", path);
  return url.toString();
}

export function runOperation<T = unknown>(op: MobileOperation, args: Record<string, unknown>, csrfToken: string) {
  return jsonRequest<T>("/api/operations", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ op, args }),
  });
}

export function completeMcpOAuthCallback(sessionId: string, name: string, callbackUrl: string, csrfToken: string) {
  return jsonRequest<{ forwarded: true }>("/api/mcp/oauth/callback", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ sessionId, name, callbackUrl }),
  });
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function uploadAttachment(sessionId: string, file: File, csrfToken: string): Promise<MobileAttachment> {
  if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new MobileApiError("Файл должен быть не пустым и не больше 10 МБ", 413);
  const url = new URL("/api/attachments", window.location.origin);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("name", file.name);
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-CSRF-Token": csrfToken },
    body: file,
  });
  const payload = await response.json().catch(() => ({})) as { error?: unknown } & MobileAttachment;
  if (!response.ok) {
    throw new MobileApiError(typeof payload.error === "string" ? payload.error : `Файл не принят (${response.status})`, response.status);
  }
  if (typeof payload.id !== "string" || typeof payload.name !== "string" ||
      !Number.isSafeInteger(payload.size) || !["text", "document"].includes(payload.kind)) {
    throw new MobileApiError("Сервер вернул неверное описание файла", 502);
  }
  return payload;
}

export function removeAttachment(sessionId: string, id: string, csrfToken: string) {
  const query = new URLSearchParams({ sessionId });
  return jsonRequest<{ removed: boolean }>(`/api/attachments/${encodeURIComponent(id)}?${query}`, {
    method: "DELETE", headers: { "X-CSRF-Token": csrfToken },
  });
}

const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_MIMES = new Set(["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/3gpp"]);

export async function transcribeAudio(sessionId: string, audio: File, csrfToken: string) {
  if (!AUDIO_MIMES.has(audio.type.toLowerCase())) throw new MobileApiError("Выберите аудиофайл поддерживаемого формата", 400);
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) throw new MobileApiError("Аудио должно быть не пустым и не больше 5 МБ", 413);
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const parts: string[] = [];
  // Keep conversion chunks aligned to 3 bytes so only the final base64 part is padded.
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  }
  const data = parts.join("");
  return runOperation<{ text: string }>("transcribeAudio", { sessionId, mimeType: audio.type, data }, csrfToken);
}

export function readDevices() {
  return jsonRequest<{ devices: MobileDevice[] }>("/api/devices");
}

export function revokeDevice(deviceId: string, csrfToken: string) {
  return jsonRequest<{ revoked: boolean }>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE", headers: { "X-CSRF-Token": csrfToken },
  });
}

export function logout(csrfToken: string) {
  return jsonRequest<{ loggedOut: boolean }>("/api/logout", {
    method: "POST", headers: { "X-CSRF-Token": csrfToken },
  });
}

export async function openEventStream(
  sessionId: string, after: number, epoch: string, csrfToken: string, signal: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch("/api/events", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ sessionId, after, epoch }),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    throw new MobileApiError(typeof payload.error === "string" ? payload.error : `Поток событий недоступен (${response.status})`, response.status);
  }
  return response.body.getReader();
}

export { parseSseBlock } from "./lib/sse.js";
export type { ParsedSseMessage } from "./lib/sse.js";

export { asLiveEvent } from "./lib/live-event.js";
