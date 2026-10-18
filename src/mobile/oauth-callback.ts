import { request as httpRequest } from "node:http";

export interface McpOAuthCallbackTarget {
  hostname: string;
  port: number;
  host: string;
  pathname: string;
  state?: string;
}

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
    if (redirectUris.length !== 1 || states.length > 1) return undefined;
    const redirect = new URL(redirectUris[0]!);
    const hostname = loopbackHost(redirect.hostname);
    if (redirect.protocol !== "http:" || !hostname || !redirect.port || redirect.username || redirect.password ||
        redirect.search || redirect.hash || !/^\/callback(?:\/[a-z0-9_-]{1,128})?$/i.test(redirect.pathname)) return undefined;
    const port = Number(redirect.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    const state = states[0];
    if (state !== undefined && (!state || state.length > 2048)) return undefined;
    return { hostname, port, host: redirect.host, pathname: redirect.pathname, ...(state ? { state } : {}) };
  } catch { return undefined; }
}

export function validateMcpOAuthCallback(value: unknown, target: McpOAuthCallbackTarget): URL | undefined {
  if (typeof value !== "string" || !value || value.length > 8192 || value !== value.trim()) return undefined;
  try {
    const callback = new URL(value);
    const hostname = loopbackHost(callback.hostname);
    if (callback.protocol !== "http:" || hostname !== target.hostname || callback.host !== target.host || Number(callback.port) !== target.port ||
        callback.pathname !== target.pathname || callback.username || callback.password || callback.hash) return undefined;
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
