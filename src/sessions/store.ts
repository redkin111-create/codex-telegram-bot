/**
 * Session store — discovers Codex CLI sessions by walking the rollout tree
 * under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, and sorts
 * them by recency.
 *
 * Codex keeps threads
 * in-process and does NOT drop per-session lock files, so there is no reliable
 * on-disk "running now" signal — `active` is always false and `listActive()` is
 * empty. Live sessions are instead tracked in-memory by the runtime registry
 * (see `/running`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { createLogger } from "../logger.js";
import { readFirstPrompt } from "./history.js";
import { cleanSessionPrompt } from "./title.js";
import type { SessionMeta } from "./types.js";

const log = createLogger("sessions:store");

/** Trailing UUID of a `rollout-...-<uuid>.jsonl` filename. */
const ROLLOUT_ID_RE =
  /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

interface Indexed {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

export class SessionStore {
  /** Cache: sessionId -> rollout file path (rebuilt on scan). */
  private index = new Map<string, string>();
  /** Codex can report threads for which the local rollout file is absent.
   * Cache negative lookups briefly: otherwise every TMA heartbeat scans the
   * entire CODEX_HOME tree synchronously and stalls the whole Node process. */
  private readonly missingUntil = new Map<string, number>();

  constructor(private readonly dir: string) {}

  available(): boolean {
    try {
      return statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }

  /** List all sessions, most recently updated first. */
  list(limit = 50): SessionMeta[] {
    const files = this.scan();
    const metas: SessionMeta[] = [];
    for (const f of files) {
      const meta = this.readMeta(f);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas.slice(0, limit);
  }

  /** Codex exposes no on-disk "running now" signal, so this is always empty. */
  listActive(): SessionMeta[] {
    return [];
  }

  get(sessionId: string): SessionMeta | undefined {
    const path = this.resolvePath(sessionId);
    if (!path) return undefined;
    return this.readMeta({ sessionId, path, mtimeMs: safeMtime(path) });
  }

  jsonlPath(sessionId: string): string {
    return this.resolvePath(sessionId) ?? join(this.dir, `${sessionId}.jsonl`);
  }

  /** Recursively find every `rollout-*.jsonl`, newest first; refresh the index. */
  private scan(): Indexed[] {
    if (!this.available()) return [];
    let names: string[];
    try {
      names = readdirSync(this.dir, { recursive: true }) as string[];
    } catch (e) {
      log.warn("cannot read sessions dir:", (e as Error).message);
      return [];
    }
    const out: Indexed[] = [];
    this.index.clear();
    for (const name of names) {
      const rel = String(name);
      if (!rel.endsWith(".jsonl") || !/rollout-/i.test(rel)) continue;
      const path = join(this.dir, rel);
      const sessionId = idFromPath(path);
      if (!sessionId) continue;
      out.push({ sessionId, path, mtimeMs: safeMtime(path) });
      this.index.set(sessionId, path);
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  private resolvePath(sessionId: string): string | undefined {
    const cached = this.index.get(sessionId);
    if (cached) {
      try {
        if (statSync(cached).isFile()) return cached;
      } catch { /* Missing or rotated rollout: refresh index below. */ }
      this.index.delete(sessionId);
    }
    if ((this.missingUntil.get(sessionId) ?? 0) > Date.now()) return undefined;
    this.scan();
    const found = this.index.get(sessionId);
    if (found) {
      this.missingUntil.delete(sessionId);
      return found;
    }
    this.missingUntil.set(sessionId, Date.now() + 15_000);
    if (this.missingUntil.size > 512) this.missingUntil.delete(this.missingUntil.keys().next().value!);
    return undefined;
  }

  private readMeta(f: Indexed): SessionMeta | undefined {
    let mtimeIso = new Date(f.mtimeMs || 0).toISOString();
    let historyBytes = 0;
    try {
      const st = statSync(f.path);
      historyBytes = st.size;
      mtimeIso = st.mtime.toISOString();
    } catch {
      return undefined;
    }
    const head = readMetaLine(f.path);
    const cwd = head.cwd || "";
    const createdAt = head.createdAt || mtimeIso;
    const title = firstPromptTitle(f.path);

    return {
      sessionId: f.sessionId,
      cwd,
      title,
      createdAt,
      updatedAt: mtimeIso,
      reason: undefined,
      lockPid: undefined,
      active: false,
      historyBytes,
    };
  }
}

/** Session id from the rollout filename UUID (fast) or the session_meta line. */
function idFromPath(path: string): string | undefined {
  const m = ROLLOUT_ID_RE.exec(path.replace(/\\/g, "/"));
  if (m) return m[1]!.toLowerCase();
  const meta = readMetaLine(path);
  return meta.id;
}

interface HeadMeta {
  id?: string;
  cwd?: string;
  createdAt?: string;
}

/** Read + parse the first `session_meta` line of a rollout file. */
function readMetaLine(path: string): HeadMeta {
  const text = readHead(path, 64 * 1024);
  if (!text) return {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Newer format: { timestamp, type:"session_meta", payload:{ id, cwd, … } }.
    const payload = (obj.payload as Record<string, unknown>) ?? obj;
    const type = String(obj.type ?? "");
    if (type && type !== "session_meta") {
      // Not the meta line — but the very first line should be it; bail after one.
      return {};
    }
    const id = str(payload.id) || str(payload.session_id) || str(obj.id);
    const cwd = str(payload.cwd) || str(obj.cwd);
    const createdAt = str(obj.timestamp) || str(payload.timestamp);
    return { id: id || undefined, cwd: cwd || undefined, createdAt: createdAt || undefined };
  }
  return {};
}

/** First user prompt of a session, used as its display title. */
function firstPromptTitle(path: string): string {
  const first = cleanSessionPrompt(readFirstPrompt(path));
  if (!first) return "(untitled)";
  const oneLine = first.replace(/\s+/g, " ");
  return oneLine.length > 80 ? oneLine.slice(0, 79) + "…" : oneLine;
}

/** Read up to `maxBytes` from the start of a file as UTF-8 text. */
function readHead(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Cross-platform "is this process still running?" check. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
