/**
 * Low-level access to Codex's on-disk login credential: `$CODEX_HOME/auth.json`
 * (default `~/.codex/auth.json`). It carries either an OpenAI API key or the
 * ChatGPT OAuth tokens (id/access/refresh). Everything account-related
 * (import an existing login, multi-account snapshot/switch) is built on it.
 *
 * We never transmit it anywhere; we only read it, validate it, and copy it
 * between the live path and per-account snapshots under the bot's data dir.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("codex-cred");

/** Guidance shown when a login can't be verified. */
export const UNSUPPORTED_LOGIN_HELP =
  "Codex сообщает, что вход не выполнен. Отправьте сюда ключ API OpenAI или выполните `codex login` " +
  "через терминал на компьютере с ботом, чтобы войти через ChatGPT. Затем сохраните аккаунт командой /accounts.";

/** Resolved CODEX_HOME. */
export function codexHomeDir(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : join(homedir(), ".codex");
}

/** The single file that carries the currently active Codex identity. */
export function codexAuthPath(): string {
  return join(codexHomeDir(), "auth.json");
}

/** ChatGPT OAuth token bundle inside auth.json. */
export interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

/** Shape of `auth.json` (only the fields we read). */
export interface CodexAuth {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens | null;
  last_refresh?: string;
}

/** Read + parse auth.json. Returns undefined when missing/unparseable. */
export async function readAuthFile(path: string): Promise<CodexAuth | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as CodexAuth;
  } catch {
    return undefined;
  }
}

/** A login is usable when it carries an API key OR ChatGPT access token. */
export function authUsable(auth: CodexAuth | undefined): boolean {
  return !!auth?.OPENAI_API_KEY || !!auth?.tokens?.access_token;
}

/** How the active login authenticates (for display). */
export function authMethod(auth: CodexAuth | undefined): "apikey" | "chatgpt" | undefined {
  if (auth?.tokens?.access_token) return "chatgpt";
  if (auth?.OPENAI_API_KEY) return "apikey";
  return undefined;
}

export interface AuthIdentity {
  email?: string;
  name?: string;
  plan?: string;
}

/** Decode a base64url JWT payload; undefined if not a JWT. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Best-effort identity (email + ChatGPT plan) from the id_token JWT claims. */
export function identityFromAuth(auth: CodexAuth | undefined): AuthIdentity {
  const idToken = auth?.tokens?.id_token;
  if (!idToken) return {};
  const claims = decodeJwtPayload(idToken);
  if (!claims) return {};
  const str = (k: string): string | undefined => (typeof claims[k] === "string" ? (claims[k] as string) : undefined);
  const email = str("email") || str("preferred_username");
  const name = str("name") || str("given_name");
  // Plan lives under the OpenAI auth namespace claim.
  const authClaim = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const plan = authClaim && typeof authClaim.chatgpt_plan_type === "string" ? authClaim.chatgpt_plan_type : undefined;
  return { email: email && email.includes("@") ? email : email, name, plan };
}

/** A short human label for a login (email → plan → method). */
export function authLabel(auth: CodexAuth | undefined): string | undefined {
  if (!auth) return undefined;
  const id = identityFromAuth(auth);
  if (id.email) return id.email;
  const method = authMethod(auth);
  if (method === "chatgpt") return id.plan ? `ChatGPT (${id.plan})` : "ChatGPT login";
  if (method === "apikey") return keyLabel(auth) ?? "API key";
  return undefined;
}

/**
 * A stable, non-reversible identity for an API-key login — a short hash of the
 * key — so multiple API-key accounts can be told apart, de-duplicated, and
 * matched against the active login (they carry no email). undefined for a
 * ChatGPT login (which is identified by its email instead).
 */
export function keyFingerprint(auth: CodexAuth | undefined): string | undefined {
  const k = auth?.OPENAI_API_KEY;
  if (typeof k !== "string" || !k || auth?.tokens?.access_token) return undefined;
  return `apikey:${createHash("sha256").update(k).digest("hex").slice(0, 12)}`;
}

/** Stable account identity for ChatGPT workspaces, without storing raw tokens. */
export function accountFingerprint(auth: CodexAuth | undefined): string | undefined {
  if (!auth?.tokens?.access_token) return keyFingerprint(auth);
  const direct = auth.tokens.account_id;
  const claims = decodeJwtPayload(auth.tokens.id_token ?? "");
  const namespaced = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId = direct || (typeof namespaced?.chatgpt_account_id === "string" ? namespaced.chatgpt_account_id : undefined);
  return accountId ? `chatgpt:${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}` : undefined;
}

/** A display label for an API-key login (masked), or undefined. */
export function keyLabel(auth: CodexAuth | undefined): string | undefined {
  const k = auth?.OPENAI_API_KEY;
  if (typeof k !== "string" || k.length < 4 || auth?.tokens?.access_token) return undefined;
  return `API key \u00B7\u00B7\u00B7\u00B7${k.slice(-4)}`;
}

export interface ImportCandidate {
  path: string;
  auth: CodexAuth;
  mtimeMs: number;
}

/**
 * Locate an existing usable Codex login on this machine — the live
 * `$CODEX_HOME/auth.json`. Returns undefined when none is present (the caller
 * then tells the user to `codex login` first).
 */
export async function findImportableAuth(): Promise<ImportCandidate | undefined> {
  const path = codexAuthPath();
  if (!existsSync(path)) return undefined;
  const auth = await readAuthFile(path);
  if (!authUsable(auth)) return undefined;
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    /* ignore */
  }
  return { path, auth: auth!, mtimeMs };
}

/** Copy an auth.json into the live path so Codex logs in as that identity. */
export async function installAuth(fromPath: string): Promise<void> {
  const dest = codexAuthPath();
  if (fromPath === dest) return;
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(fromPath, dest);
  log.info(`installed Codex auth from ${fromPath}`);
}
