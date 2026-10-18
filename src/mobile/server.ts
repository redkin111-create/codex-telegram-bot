import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import type { TmaJob, TmaOperation } from "../tma/protocol.js";
import { MobileAttachmentStore, MAX_MOBILE_ATTACHMENT_BYTES, type MobilePromptAttachment } from "./attachments.js";
import type { MiniAppAgent, MobileLocalJob, MobileLocalOperation } from "../tma/agent.js";
import type { LiveEvent, TmaLiveFeed } from "../tma/live.js";
import { MobileAuthStore } from "./auth.js";
import type { MobileAccountController } from "./accounts.js";

const SESSION_COOKIE = "__Host-codex-mobile-session";
const PAIR_COOKIE = "__Host-codex-mobile-pair";
const CSRF_COOKIE = "__Host-codex-mobile-csrf";
const RASTER_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MUTATING_OPERATIONS = new Set<TmaOperation>([
  "create", "select", "send", "cancel", "queue", "queueRemove", "queueResume",
]);
const MOBILE_MUTATING_OPERATIONS = new Set<MobileLocalOperation>(["createThreadSection", "renameThreadSection", "deleteThreadSection", "moveThreadToSection", "editAndRetry", "transcribeAudio", "startRealtime", "stopRealtime", "setModel", "setMode", "setReasoning", "setGoal", "clearGoal", "setSkillEnabled", "setMcpConfigEnabled", "restartCodex", "mcpOAuthLogin", "callMcpTool", "readMcpResource", "steer", "forkThread", "createSideChat", "compactThread", "reviewThread", "archiveThread", "unarchiveThread", "renameThread", "deleteThread", "installPlugin", "uninstallPlugin", "addMarketplace", "removeMarketplace", "upgradeMarketplace", "createWorktree", "terminalExec", "terminalStart", "terminalInput", "terminalResize", "terminalStop", "stopBackgroundTerminal", "writeFile", "createFile", "gitResolveConflictStage", "gitStage", "gitUnstage", "gitCommit", "gitCreateBranch", "gitSwitchBranch", "gitTrackRemoteBranch", "gitFetch", "gitPush"]);
const MOBILE_GLOBAL_MUTATING_OPERATIONS = new Set<MobileLocalOperation>(["createThreadSection", "renameThreadSection", "deleteThreadSection"]);
const MOBILE_READ_OPERATIONS = new Set<MobileLocalOperation>(["listThreadSections", "searchThreads", "listMoreThreads", "latestEditableTurn", "listEditableTurns", "listMcpConfig", "listRealtimeVoices", "readImage", "terminalRead", "listBackgroundTerminals"]);

export interface MobileAgent {
  canReadSession(id: string, userId: number): Promise<boolean>;
  execute(job: TmaJob, attachments?: readonly MobilePromptAttachment[]): Promise<unknown>;
  executeMobile?(job: MobileLocalJob): Promise<unknown>;
}

export interface MobileApprovals {
  listFor(ownerId: number, sessionId: string): Array<{ id: string; title: string; kind: string; summary?: string; options: Array<{ id: string; label: string }> }>;
  resolve(ownerId: number, sessionId: string, id: string, optionId: string): boolean;
}

export interface MobileServerOptions {
  auth: MobileAuthStore;
  agent: MobileAgent;
  accounts?: MobileAccountController;
  approvals?: MobileApprovals;
  feed: TmaLiveFeed;
  dataDir?: string;
  staticRoot?: string;
  port?: number;
  allowedOrigins?: string[];
  now?: () => number;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'");
}

async function readJson(req: IncomingMessage, maxBytes = 32 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > maxBytes) throw new Error("Слишком большой запрос");
    chunks.push(data);
  }
  if (!length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ожидался JSON-объект");
  return parsed as Record<string, unknown>;
}

async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Файл должен быть не больше 10 МБ");
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw new Error("Сжатые загрузки файлов не поддерживаются");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > maxBytes) throw new Error("Файл должен быть не больше 10 МБ");
    chunks.push(data);
  }
  return Buffer.concat(chunks, length);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const ix = part.indexOf("=");
    if (ix >= 0 && part.slice(0, ix).trim() === name) return decodeURIComponent(part.slice(ix + 1).trim());
  }
  return undefined;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number, httpOnly = true): void {
  const http = httpOnly ? "; HttpOnly" : "";
  res.appendHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict${http}`);
}

function clearCookie(res: ServerResponse, name: string, httpOnly = true): void {
  const http = httpOnly ? "; HttpOnly" : "";
  res.appendHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; Secure; SameSite=Strict${http}`);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Ошибка Codex";
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) || "Ошибка Codex";
}

function allowedOrigin(req: IncomingMessage, server: Server, configured: Set<string>): boolean {
  const raw = req.headers.origin;
  if (typeof raw !== "string") return false;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.origin !== raw || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false;
  if (configured.has(raw)) return true;
  const address = server.address();
  return !!address && typeof address !== "string" && raw === `http://127.0.0.1:${address.port}`;
}

function sessionDevice(req: IncomingMessage, auth: MobileAuthStore) {
  return auth.authenticate(cookie(req, SESSION_COOKIE));
}

function csrfAuthorized(req: IncomingMessage, deviceId: string, auth: MobileAuthStore): boolean {
  const header = req.headers["x-csrf-token"];
  return typeof header === "string" && auth.verifyCsrf(deviceId, header) &&
    header === cookie(req, CSRF_COOKIE);
}

function safeSessionId(value: string): boolean {
  return /^[a-z0-9_-]{8,128}$/i.test(value);
}

function decodeRasterImage(value: unknown): { mime: string; bytes: Buffer } | undefined {
  const image = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mime = typeof image.mime === "string" ? image.mime : "";
  const data = typeof image.data === "string" ? image.data : "";
  if (!RASTER_IMAGE_MIMES.has(mime) ||
      data.length > 4 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return undefined;
  const bytes = Buffer.from(data, "base64");
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === "image/webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
    : bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a";
  return valid && bytes.length <= 3 * 1024 * 1024 ? { mime, bytes } : undefined;
}

function staticFile(root: string, pathname: string): { path: string; type: string } | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded === "/") decoded = "/index.html";
  const file = resolve(root, `.${decoded}`);
  const rel = relative(resolve(root), file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(file) === resolve(root)) return undefined;
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  };
  const type = types[extname(file).toLowerCase()];
  return type ? { path: file, type } : undefined;
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const file = staticFile(root, pathname);
  if (!file || !existsSync(file.path) || !statSync(file.path).isFile()) {
    json(res, 404, { error: "Not found" });
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", file.type);
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file.path);
    stream.once("error", reject);
    res.once("close", resolvePromise);
    res.once("finish", resolvePromise);
    stream.pipe(res);
  });
}

export function createMobileServer(options: MobileServerOptions): Server {
  const origins = new Set((options.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean));
  const now = options.now ?? Date.now;
  const started = new Map<string, { at: number; count: number }>();
  const attachments = new MobileAttachmentStore(options.dataDir, now);
  const server = createServer((req, res) => {
    securityHeaders(res);
    void route(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, 400, { error: safeError(error) });
    });
  });

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    const isApi = path.startsWith("/api/");
    const originRequired = isApi && method !== "GET" && method !== "HEAD";
    if (isApi && (originRequired || req.headers.origin !== undefined) && !allowedOrigin(req, server, origins)) {
      json(res, 403, { error: "Origin не разрешён" });
      return;
    }

    if (path === "/api/pairing/start" && method === "POST") {
      const address = req.socket.remoteAddress ?? "unknown";
      const rate = started.get(address);
      if (rate && now() - rate.at < 60_000 && rate.count >= 6) { json(res, 429, { error: "Слишком много запросов на привязку" }); return; }
      if (!rate || now() - rate.at >= 60_000) started.set(address, { at: now(), count: 1 });
      else rate.count++;
      for (const [key, value] of started) if (now() - value.at > 5 * 60_000) started.delete(key);
      const body = await readJson(req, 4096);
      if (typeof body.deviceName !== "string") { json(res, 400, { error: "Укажите имя устройства" }); return; }
      try {
        const challenge = options.auth.beginPairing(body.deviceName);
        setCookie(res, PAIR_COOKIE, challenge.pairingCookie, 600);
        json(res, 201, { pairingId: challenge.id, code: challenge.code, expiresAt: challenge.expiresAt });
      } catch (error) { json(res, 429, { error: safeError(error) }); }
      return;
    }

    if (path === "/api/pairing/status" && method === "GET") {
      const result = options.auth.completePairing(cookie(req, PAIR_COOKIE) ?? "");
      if (!result) { clearCookie(res, PAIR_COOKIE); json(res, 410, { error: "Код привязки истёк" }); return; }
      if (result.status === "pending") { json(res, 200, { status: "pending" }); return; }
      setCookie(res, SESSION_COOKIE, result.cookieValue, Math.floor((30 * 24 * 60 * 60 * 1000) / 1000));
      setCookie(res, CSRF_COOKIE, result.csrfToken, Math.floor((30 * 24 * 60 * 60 * 1000) / 1000), false);
      clearCookie(res, PAIR_COOKIE);
      json(res, 200, { status: "approved", csrfToken: result.csrfToken, device: result.device });
      return;
    }

    if (!isApi) {
      if (method !== "GET" && method !== "HEAD") { json(res, 404, { error: "Not found" }); return; }
      if (!options.staticRoot) { json(res, 503, { error: "Мобильный интерфейс ещё не собран" }); return; }
      await serveStatic(options.staticRoot, path, res);
      return;
    }

    const device = sessionDevice(req, options.auth);
    if (!device) { json(res, 401, { error: "Устройство не авторизовано" }); return; }
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      if (!allowedOrigin(req, server, origins)) { json(res, 403, { error: "Origin не разрешён" }); return; }
      if (!csrfAuthorized(req, device.id, options.auth)) { json(res, 403, { error: "CSRF-проверка не пройдена" }); return; }
    }

    if (path === "/api/session" && method === "GET") {
      const csrfToken = cookie(req, CSRF_COOKIE);
      if (!csrfToken || !options.auth.verifyCsrf(device.id, csrfToken)) { json(res, 401, { error: "Сессия требует повторной привязки" }); return; }
      json(res, 200, { device, csrfToken });
      return;
    }
    if (path === "/api/accounts" && method === "GET") {
      if (!options.accounts) { json(res, 503, { error: "Управление аккаунтами недоступно" }); return; }
      try { json(res, 200, await options.accounts.snapshot(device.ownerId)); }
      catch (error) {
        const message = safeError(error);
        json(res, message.includes("Доступ к аккаунтам запрещён") ? 403 : 502, { error: message });
      }
      return;
    }
    if (path === "/api/accounts" && method === "POST") {
      if (!options.accounts) { json(res, 503, { error: "Управление аккаунтами недоступно" }); return; }
      try {
        const body = await readJson(req, 8192);
        json(res, 200, await options.accounts.execute(device.ownerId, body));
      } catch (error) {
        const message = safeError(error);
        const status = message.includes("Доступ к аккаунтам запрещён") ? 403
          : message.includes("Codex занят") || message.includes("ожидающие запросы") ? 409
          : message.includes("Codex") || message.includes("runtime") ? 502
          : 400;
        json(res, status, { error: message });
      }
      return;
    }
    if (path === "/api/attachments" && method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const name = url.searchParams.get("name") ?? "";
      if (!safeSessionId(sessionId) || !name || name.length > 300 ||
          !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к вложению запрещён" }); return;
      }
      let bytes: Buffer;
      try { bytes = await readBytes(req, MAX_MOBILE_ATTACHMENT_BYTES); }
      catch (error) {
        const message = safeError(error);
        json(res, message.includes("10 МБ") ? 413 : 415, { error: message });
        return;
      }
      try {
        const mimeType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream";
        const descriptor = await attachments.add(device.ownerId, device.id, sessionId, name, mimeType, bytes);
        json(res, 201, descriptor);
      } catch (error) {
        const message = safeError(error);
        const status = message.includes("каталога данных") ? 503
          : message.includes("Слишком много ожидающих") ? 429
          : message.includes("не больше 10 МБ") ? 413
          : 415;
        json(res, status, { error: message });
      }
      return;
    }
    const removeAttachment = /^\/api\/attachments\/([a-f0-9-]{36})$/i.exec(path);
    if (removeAttachment && method === "DELETE") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к вложению запрещён" }); return;
      }
      const removed = await attachments.remove(device.ownerId, device.id, sessionId, removeAttachment[1]!);
      json(res, removed ? 200 : 404, removed ? { removed: true } : { error: "Вложение не найдено или уже отправлено" });
      return;
    }
    if (path === "/api/logout" && method === "POST") {
      options.auth.revokeDevice(device.ownerId, device.id);
      clearCookie(res, SESSION_COOKIE);
      clearCookie(res, CSRF_COOKIE, false);
      json(res, 200, { loggedOut: true });
      return;
    }
    if (path === "/api/devices" && method === "GET") {
      json(res, 200, { devices: options.auth.listDevices(device.ownerId) });
      return;
    }
    const revoke = /^\/api\/devices\/([a-f0-9-]{36})$/.exec(path);
    if (revoke && method === "DELETE") {
      const revoked = options.auth.revokeDevice(device.ownerId, revoke[1]!);
      json(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: "Устройство не найдено" });
      return;
    }

    if (path === "/api/snapshot" && method === "GET") {
      try {
        const value = await execute("snapshot", device.ownerId, {});
        const snapshot = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.map((entry) => {
          const session = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
          const live = options.feed.getStatus(String(session.id ?? ""));
          return {
            ...session,
            liveStatus: live?.status ?? (session.busy === true ? "working" : "unknown"),
            liveLabel: live?.label ?? (session.busy === true ? "Codex работает" : "Статус неизвестен"),
          };
        }) : [];
        json(res, 200, { ...snapshot, sessions });
      }
      catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if (path === "/api/approvals" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к сеансу запрещён" }); return;
      }
      json(res, 200, { approvals: options.approvals?.listFor(device.ownerId, sessionId) ?? [] });
      return;
    }
    const approval = /^\/api\/approvals\/([a-f0-9-]{36})$/.exec(path);
    if (approval && method === "POST") {
      const body = await readJson(req, 4096);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const optionId = typeof body.optionId === "string" ? body.optionId : "";
      if (!safeSessionId(sessionId) || !optionId || optionId.length > 100 ||
          !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к подтверждению запрещён" }); return;
      }
      const resolved = options.approvals?.resolve(device.ownerId, sessionId, approval[1]!, optionId) ?? false;
      json(res, resolved ? 200 : 409, resolved ? { resolved: true } : { error: "Запрос истёк или уже обработан" });
      return;
    }
    if (path === "/api/capabilities" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (sessionId && (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId))) {
        json(res, 403, { error: "Доступ к сеансу запрещён" }); return;
      }
      if (!options.agent.executeMobile) { json(res, 503, { error: "Инвентарь Codex недоступен" }); return; }
      try { json(res, 200, await options.agent.executeMobile({ op: "capabilities", userId: device.ownerId, args: sessionId ? { sessionId } : {} })); }
      catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if ((path === "/api/files" || path === "/api/file") && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const filePath = url.searchParams.get("path") ?? "";
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к файлам проекта запрещён" }); return;
      }
      if (!options.agent.executeMobile) { json(res, 503, { error: "Файлы проекта недоступны" }); return; }
      try {
        const result = await options.agent.executeMobile({
          op: path === "/api/files" ? "files" : "readFile", userId: device.ownerId,
          args: { sessionId, path: filePath },
        });
        json(res, 200, result);
      } catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if ((path === "/api/git/status" || path === "/api/git/diff") && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к Git проекта запрещён" }); return;
      }
      if (!options.agent.executeMobile) { json(res, 503, { error: "Git проекта недоступен" }); return; }
      try {
        const args: Record<string, unknown> = { sessionId };
        if (path === "/api/git/diff") {
          const selectedPath = url.searchParams.get("path");
          const previousPath = url.searchParams.get("previousPath");
          if (selectedPath !== null) args.path = selectedPath;
          if (previousPath !== null) args.previousPath = previousPath;
        }
        const result = await options.agent.executeMobile({
          op: path === "/api/git/status" ? "gitStatus" : "gitDiff", userId: device.ownerId, args,
        });
        json(res, 200, result);
      } catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if (path === "/api/git/conflict-stages" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const filePath = url.searchParams.get("path") ?? "";
      if (!safeSessionId(sessionId) || !filePath || filePath.length > 1200 ||
          !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к конфликту Git запрещён" }); return;
      }
      if (!options.agent.executeMobile) { json(res, 503, { error: "Стадии Git-конфликта недоступны" }); return; }
      try {
        const result = await options.agent.executeMobile({
          op: "gitConflictStages", userId: device.ownerId, args: { sessionId, path: filePath },
        });
        json(res, 200, result);
      } catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    const history = /^\/api\/history\/([^/]+)$/.exec(path);
    if (history && method === "GET") {
      const sessionId = decodeURIComponent(history[1]!);
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) { json(res, 403, { error: "Доступ к сеансу запрещён" }); return; }
      try { json(res, 200, await execute("history", device.ownerId, { sessionId, includeTools: url.searchParams.get("tools") === "true" })); }
      catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    const activity = /^\/api\/activity\/([^/]+)$/.exec(path);
    if (activity && method === "GET") {
      const sessionId = decodeURIComponent(activity[1]!);
      if (!safeSessionId(sessionId) || !await options.agent.canReadSession(sessionId, device.ownerId)) { json(res, 403, { error: "Доступ к сеансу запрещён" }); return; }
      try {
        const value = await execute("activity", device.ownerId, { sessionId });
        const activityValue = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const live = options.feed.getStatus(sessionId);
        json(res, 200, {
          ...activityValue,
          liveStatus: live?.status ?? (activityValue.busy === true ? "working" : "unknown"),
          liveLabel: live?.label ?? (activityValue.busy === true ? "Codex работает" : "Статус неизвестен"),
        });
      }
      catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if ((path === "/api/image" || path === "/api/project-image") && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const imagePath = url.searchParams.get("path") ?? "";
      if (!safeSessionId(sessionId) || !imagePath || imagePath.length > 1600 ||
          !await options.agent.canReadSession(sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к изображению запрещён" }); return;
      }
      try {
        if (path === "/api/project-image" && !options.agent.executeMobile) {
          json(res, 503, { error: "Просмотр изображения проекта недоступен" }); return;
        }
        const value = path === "/api/project-image"
          ? await options.agent.executeMobile!({ op: "readImage", userId: device.ownerId, args: { sessionId, path: imagePath } })
          : await execute("image", device.ownerId, { sessionId, path: imagePath });
        const image = decodeRasterImage(value);
        if (!image) { json(res, 415, { error: "Неподдерживаемое или повреждённое изображение" }); return; }
        res.statusCode = 200;
        res.setHeader("Content-Type", image.mime);
        res.setHeader("Content-Length", String(image.bytes.length));
        res.setHeader("Cache-Control", "no-store");
        res.end(image.bytes);
      } catch (error) { json(res, 404, { error: safeError(error) }); }
      return;
    }
    if (path === "/api/operations" && method === "POST") {
      const body = await readJson(req, 7 * 1024 * 1024);
      if (typeof body.op !== "string" || (!MUTATING_OPERATIONS.has(body.op as TmaOperation) && !MOBILE_MUTATING_OPERATIONS.has(body.op as MobileLocalOperation) && !MOBILE_READ_OPERATIONS.has(body.op as MobileLocalOperation)) ||
          !body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
        json(res, 400, { error: "Неизвестная операция" }); return;
      }
      const args = { ...(body.args as Record<string, unknown>) };
      if (typeof args.sessionId === "string" && !await options.agent.canReadSession(args.sessionId, device.ownerId)) {
        json(res, 403, { error: "Доступ к сеансу запрещён" }); return;
      }
      let promptAttachments: MobilePromptAttachment[] = [];
      let attachmentIds: string[] = [];
      if (body.op === "send" || body.op === "steer") {
        const rawIds = args.attachmentIds;
        delete args.attachmentIds;
        delete args.mobileAttachments;
        if (rawIds !== undefined && (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string"))) {
          json(res, 400, { error: "Список вложений недопустим" }); return;
        }
        attachmentIds = (rawIds ?? []) as string[];
        if (body.op === "steer" && attachmentIds.length > 0) {
          json(res, 400, { error: "Файлы можно отправлять в очередь или новый запрос, но не добавлять к активному ходу" }); return;
        }
        if (attachmentIds.length > 0) {
          if (typeof args.sessionId !== "string" || typeof args.requestId !== "string") {
            json(res, 400, { error: "Для вложения нужен выбранный сеанс и идентификатор запроса" }); return;
          }
          try {
            promptAttachments = await attachments.resolveForPrompt(
              device.ownerId, device.id, args.sessionId, attachmentIds, args.requestId,
            );
          } catch (error) { json(res, 403, { error: safeError(error) }); return; }
        }
      } else {
        delete args.attachmentIds;
        delete args.mobileAttachments;
      }
      if (MOBILE_READ_OPERATIONS.has(body.op as MobileLocalOperation)) {
        if (!options.agent.executeMobile) { json(res, 503, { error: "Настройки Codex недоступны" }); return; }
        try { json(res, 200, await options.agent.executeMobile({ op: body.op as MobileLocalOperation, userId: device.ownerId, args })); }
        catch (error) { json(res, 502, { error: safeError(error) }); }
        return;
      }
      if (MOBILE_MUTATING_OPERATIONS.has(body.op as MobileLocalOperation)) {
        if (MOBILE_GLOBAL_MUTATING_OPERATIONS.has(body.op as MobileLocalOperation)) {
          if (!options.agent.executeMobile) { json(res, 503, { error: "Настройки Codex недоступны" }); return; }
          try { json(res, 200, await options.agent.executeMobile({ op: body.op as MobileLocalOperation, userId: device.ownerId, args })); }
          catch (error) { json(res, 502, { error: safeError(error) }); }
          return;
        }
        if (typeof args.sessionId !== "string" || !safeSessionId(args.sessionId) || !await options.agent.canReadSession(args.sessionId, device.ownerId)) {
          json(res, 403, { error: "Доступ к сеансу запрещён" }); return;
        }
        if (!options.agent.executeMobile) { json(res, 503, { error: "Настройки Codex недоступны" }); return; }
        try { json(res, 200, await options.agent.executeMobile({ op: body.op as MobileLocalOperation, userId: device.ownerId, args })); }
        catch (error) { json(res, 502, { error: safeError(error) }); }
        return;
      }
      try {
        const result = await execute(body.op as TmaOperation, device.ownerId, args, promptAttachments);
        if (attachmentIds.length > 0 && typeof args.requestId === "string") {
          attachments.complete(attachmentIds, device.id, args.requestId);
        }
        json(res, 200, result);
      }
      catch (error) { json(res, 502, { error: safeError(error) }); }
      return;
    }
    if (path === "/api/events" && method === "POST") {
      const body = await readJson(req, 2048);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const after = typeof body.after === "number" ? body.after : 0;
      const epoch = typeof body.epoch === "string" ? body.epoch : "";
      if (!safeSessionId(sessionId) || !Number.isSafeInteger(after) || after < 0 || (epoch !== "" && !/^[a-f0-9]{24}$/.test(epoch))) {
        json(res, 400, { error: "Неверный курсор потока" }); return;
      }
      if (!await options.agent.canReadSession(sessionId, device.ownerId)) { json(res, 403, { error: "Доступ к сеансу запрещён" }); return; }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": connected\n\n");
      res.write(`event: hello\ndata: ${JSON.stringify({ epoch: options.feed.epoch })}\n\n`);
      let stopped = false;
      let unsubscribe = () => {};
      const close = () => { if (stopped) return; stopped = true; clearInterval(heartbeat); unsubscribe(); };
      const end = () => { close(); if (!res.destroyed && !res.writableEnded) res.end(); };
      res.once("close", close);
      const push = (event: LiveEvent) => {
        if (stopped || res.destroyed || res.writableEnded) return;
        if (!res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) end();
      };
      const cursor = epoch === options.feed.epoch ? after : 0;
      unsubscribe = options.feed.subscribe(sessionId, cursor, push);
      if (stopped || res.destroyed || res.writableEnded) { unsubscribe(); return; }
      const heartbeat = setInterval(() => {
        if (!options.auth.authenticate(cookie(req, SESSION_COOKIE)) || !options.auth.verifyCsrf(device.id, cookie(req, CSRF_COOKIE))) {
          res.write("event: revoked\ndata: {}\n\n"); end(); return;
        }
        if (!res.write(": heartbeat\n\n")) end();
      }, 15_000);
      heartbeat.unref();
      return;
    }
    json(res, 404, { error: "Not found" });
  };

  const execute = (op: TmaOperation, userId: number, args: Record<string, unknown>, promptAttachments?: readonly MobilePromptAttachment[]) =>
    options.agent.execute({ id: randomBytes(12).toString("hex"), op, userId, args }, promptAttachments);

  return server;
}
