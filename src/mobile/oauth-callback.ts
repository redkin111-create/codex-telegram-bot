import { request as httpRequest } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ExactMcpOAuthCallbackTarget {
  type: "exact";
  hostname: string;
  port: number;
  host: string;
  pathname: string;
  state?: string;
}

export interface CodexLoopbackOAuthCallbackTarget {
  type: "codex-loopback";
  state?: string;
}

export type McpOAuthCallbackTarget = ExactMcpOAuthCallbackTarget | CodexLoopbackOAuthCallbackTarget;

function loopbackHost(value: string): string | undefined {
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" ? host : host === "localhost" ? "127.0.0.1" : undefined;
}

export function mcpOAuthCallbackTarget(value: unknown): McpOAuthCallbackTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const authorizationUrl = (value as Record<string, unknown>).authorizationUrl;
  if (typeof authorizationUrl !== "string" || authorizationUrl.length > 16_384) return undefined;
  try {
    const authorization = new URL(authorizationUrl);
    if (authorization.protocol !== "https:" || authorization.username || authorization.password) return undefined;
    const redirectUris = authorization.searchParams.getAll("redirect_uri");
    const states = authorization.searchParams.getAll("state");
    if (states.length > 1) return undefined;
    const state = states[0];
    if (state !== undefined && (!state || state.length > 2048)) return undefined;
    if (redirectUris.length === 0) {
      const requestUris = authorization.searchParams.getAll("request_uri");
      if (requestUris.length !== 1 || !requestUris[0] || requestUris[0].length > 8192) return undefined;
      return { type: "codex-loopback", ...(state ? { state } : {}) };
    }
    if (redirectUris.length !== 1) return undefined;
    const redirect = new URL(redirectUris[0]!);
    const hostname = loopbackHost(redirect.hostname);
    if (redirect.protocol !== "http:" || !hostname || !redirect.port || redirect.username || redirect.password ||
        redirect.search || redirect.hash || !/^\/callback(?:\/[a-z0-9_-]{1,128})?$/i.test(redirect.pathname)) return undefined;
    const port = Number(redirect.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { type: "exact", hostname, port, host: redirect.host, pathname: redirect.pathname, ...(state ? { state } : {}) };
  } catch { return undefined; }
}

export function validateMcpOAuthCallback(value: unknown, target: McpOAuthCallbackTarget): URL | undefined {
  if (typeof value !== "string" || !value || value.length > 8192 || value !== value.trim()) return undefined;
  try {
    const callback = new URL(value);
    const hostname = loopbackHost(callback.hostname);
    if (callback.protocol !== "http:" || !hostname || !callback.port || callback.username || callback.password || callback.hash ||
        !/^\/callback(?:\/[a-z0-9_-]{1,128})?$/i.test(callback.pathname)) return undefined;
    const port = Number(callback.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (target.type === "exact" && (hostname !== target.hostname || callback.host !== target.host || port !== target.port ||
        callback.pathname !== target.pathname)) return undefined;
    const allowed = new Set(["code", "state", "error", "error_description", "iss"]);
    const counts = new Map<string, number>();
    for (const key of callback.searchParams.keys()) {
      if (!allowed.has(key)) return undefined;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count !== 1)) return undefined;
    const state = callback.searchParams.get("state");
    const code = callback.searchParams.get("code");
    const error = callback.searchParams.get("error");
    if (!state || state.length > 2048 || (target.state !== undefined && state !== target.state) ||
        (!!code === !!error) || (code !== null && !code) || (error !== null && !error) ||
        (callback.searchParams.has("error_description") && !error)) return undefined;
    return callback;
  } catch { return undefined; }
}

function endpoint(value: string): { hostname: string; port: number } | undefined {
  let hostname: string;
  let portText: string;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (bracketed) { hostname = bracketed[1]!; portText = bracketed[2]!; }
  else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) return undefined;
    hostname = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { hostname, port };
}

function matchesEndpoint(value: string, hostname: string, port: number): boolean {
  const found = endpoint(value);
  return !!found && loopbackHost(found.hostname) === loopbackHost(hostname) && found.port === port;
}

export function processOwnsLoopbackTcpListener(output: string, pid: number, hostname: string, port: number): boolean {
  if (!loopbackHost(hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (match && Number(match[2]) === pid && matchesEndpoint(match[1]!, hostname, port)) return true;
  }
  return false;
}

export function processOwnsLoopbackSsListener(output: string, pid: number, hostname: string, port: number): boolean {
  if (!loopbackHost(hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*LISTEN\s+\S+\s+\S+\s+(\S+)\s+\S+\s+(.+)$/i.exec(line);
    if (match && new RegExp(`(?:^|[, (])pid=${pid}(?:[, )]|$)`).test(match[2]!) && matchesEndpoint(match[1]!, hostname, port)) return true;
  }
  return false;
}

export function processOwnsLoopbackLsofListener(output: string, pid: number, hostname: string, port: number): boolean {
  if (!loopbackHost(hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return false;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\S+\s+(\d+)\s+.*\bTCP\s+(\S+)\s+\(LISTEN\)\s*$/i.exec(line);
    if (match && Number(match[1]) === pid && matchesEndpoint(match[2]!, hostname, port)) return true;
  }
  return false;
}

/** Fail closed unless the callback socket is an exact loopback listener owned by the Codex app-server process. */
export async function isLoopbackListenerOwnedByProcess(pid: number | undefined, hostname: string, port: number): Promise<boolean> {
  if (!pid || !Number.isInteger(pid) || pid < 1 || !loopbackHost(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFile("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 3000, maxBuffer: 512 * 1024, windowsHide: true });
      return processOwnsLoopbackTcpListener(stdout, pid, hostname, port);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { timeout: 3000, maxBuffer: 512 * 1024, windowsHide: true });
      return processOwnsLoopbackLsofListener(stdout, pid, hostname, port);
    }
    if (process.platform === "linux") {
      const { stdout } = await execFile("ss", ["-H", "-ltnp"], { timeout: 3000, maxBuffer: 512 * 1024, windowsHide: true });
      return processOwnsLoopbackSsListener(stdout, pid, hostname, port);
    }
  } catch { /* The process or listener cannot be confirmed; fail closed. */ }
  return false;
}

export async function forwardMcpOAuthCallback(callback: URL): Promise<number> {
  const hostname = loopbackHost(callback.hostname);
  const port = Number(callback.port);
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Неверный локальный callback");
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname,
      port,
      method: "GET",
      path: `${callback.pathname}${callback.search}`,
      headers: { Host: callback.host, Accept: "text/plain" },
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 0;
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        size += Buffer.byteLength(chunk);
        if (size > 4096) response.destroy(new Error("Слишком большой ответ callback"));
      });
      response.once("error", reject);
      response.once("end", () => resolve(status));
      response.resume();
    });
    request.setTimeout(5000, () => request.destroy(new Error("Истекло время ожидания callback Codex")));
    request.once("error", reject);
    request.end();
  });
}
