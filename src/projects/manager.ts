/** Project discovery and path policy for Telegram project browsing. */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep, win32 } from "node:path";
import { homedir } from "node:os";
import type { SessionMeta } from "../sessions/types.js";
import { createLogger } from "../logger.js";

const log = createLogger("projects");
const IGNORE = new Set([
  "node_modules", ".git", ".history", "dist", "build", "out", ".cache",
  "target", ".venv", "__pycache__",
]);

export interface ProjectEntry {
  /** Codex's stable project identifier, when returned by project/list. */
  id?: string;
  name: string;
  path: string;
  /** All roots for multi-root Codex projects. */
  roots?: string[];
  position?: number;
  lastUsed: number;
}

/** Pick up to `limit` real project directories from the latest Codex sessions. */
export function recentProjects(sessions: SessionMeta[], limit = 500): ProjectEntry[] {
  const byPath = new Map<string, ProjectEntry>();
  for (const session of sessions.slice(0, limit)) {
    const canonical = canonicalExistingDirectory(session.cwd);
    if (!canonical) continue;
    const key = pathKey(canonical);
    const parsedTime = Date.parse(session.updatedAt);
    const lastUsed = Number.isFinite(parsedTime) ? parsedTime : 0;
    const old = byPath.get(key);
    if (!old || lastUsed > old.lastUsed) {
      byPath.set(key, { name: basename(canonical) || canonical, path: canonical, lastUsed });
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Canonicalize an existing directory, resolving symlinks; missing paths fail closed. */
export function canonicalExistingDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync.native(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Separator-aware containment check; Windows paths compare case-insensitively. */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const windowsPath = looksLikeWindowsPath(root) || looksLikeWindowsPath(candidate);
  const from = windowsPath ? win32.resolve(root).toLowerCase() : resolve(root);
  const to = windowsPath ? win32.resolve(candidate).toLowerCase() : resolve(candidate);
  const rel = windowsPath ? win32.relative(from, to) : relative(from, to);
  const separator = windowsPath ? "\\" : sep;
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${separator}`) && !(windowsPath ? win32.isAbsolute(rel) : rel.startsWith(sep)));
}

/** Same-path comparison after normalization, with Windows case folding. */
export function sameProjectPath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function pathKey(path: string): string {
  return looksLikeWindowsPath(path) ? win32.resolve(path).toLowerCase() : resolve(path);
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path);
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "..");
}

export class ProjectManager {
  constructor(private readonly roots: string[]) {}

  /** List only immediate child directories of explicitly configured roots. */
  list(limit = 100): ProjectEntry[] {
    const byPath = new Map<string, ProjectEntry>();
    for (const configuredRoot of this.roots) {
      const root = canonicalExistingDirectory(configuredRoot);
      if (!root) continue;
      let children: string[];
      try {
        children = readdirSync(root);
      } catch (e) {
        log.debug(`cannot read root ${root}:`, (e as Error).message);
        continue;
      }
      for (const child of children) {
        if (IGNORE.has(child.toLowerCase()) || child.startsWith(".")) continue;
        const candidate = canonicalExistingDirectory(join(root, child));
        // Do not let a symlink inside an allowed root expose an outside folder.
        if (!candidate || !isPathWithinRoot(root, candidate)) continue;
        const key = pathKey(candidate);
        if (!byPath.has(key)) {
          let lastUsed = 0;
          try { lastUsed = statSync(candidate).mtimeMs; } catch { /* gone during scan */ }
          byPath.set(key, { name: basename(candidate), path: candidate, lastUsed });
        }
      }
    }
    return [...byPath.values()]
      .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  search(query: string, limit = 100): ProjectEntry[] {
    const q = query.trim().toLowerCase();
    return this.list(1000).filter((p) => p.name.toLowerCase().includes(q)).slice(0, limit);
  }

  /** Resolve a Telegram-supplied path only inside an allowlisted root or an existing session cwd. */
  resolveAllowedPath(raw: string, sessionCwds: string[] = []): string | undefined {
    const input = raw.trim();
    if (!input || hasParentTraversal(input)) return undefined;
    const expanded = input === "~" ? homedir()
      : input.startsWith("~/") || input.startsWith("~\\") ? join(homedir(), input.slice(2))
      : input;
    const candidate = canonicalExistingDirectory(expanded);
    if (!candidate) return undefined;
    for (const configuredRoot of this.roots) {
      const root = canonicalExistingDirectory(configuredRoot);
      if (root && isPathWithinRoot(root, candidate)) return candidate;
    }
    for (const cwd of sessionCwds) {
      const known = canonicalExistingDirectory(cwd);
      if (known && sameProjectPath(known, candidate)) return candidate;
    }
    return undefined;
  }

  /** Create a folder only under the first explicitly configured root. */
  create(name: string): ProjectEntry {
    const clean = name.trim().replace(/[<>:"/\\|?*]/g, "_");
    if (!clean || clean === "." || clean === "..") throw new Error("Invalid project name.");
    const root = this.roots[0] && canonicalExistingDirectory(this.roots[0]);
    if (!root) throw new Error("No existing project root configured in PROJECT_ROOTS.");
    const full = join(root, clean);
    if (existsSync(full)) throw new Error(`"${clean}" already exists in the project root.`);
    mkdirSync(full);
    const canonical = canonicalExistingDirectory(full);
    if (!canonical || !isPathWithinRoot(root, canonical)) throw new Error("The new project path is outside PROJECT_ROOTS.");
    return { name: basename(canonical), path: canonical, lastUsed: Date.now() };
  }

  isDirectory(path: string): boolean {
    return canonicalExistingDirectory(path) !== undefined;
  }

  get hasRoots(): boolean {
    return this.roots.length > 0;
  }
}
