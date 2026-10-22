/**
 * Atomic JSON persistence for bot settings and scheduled tasks. Fail visibly
 * on corrupt files and failed writes; never overwrite the only good copy with
 * defaults or mutate in-memory state before a write commits successfully.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("json-store");

export class JsonStore<T> {
  private data: T;

  constructor(
    private readonly path: string,
    private readonly fallback: T,
    private readonly validate?: (value: unknown) => boolean,
  ) {
    this.data = this.read();
  }

  get(): T {
    return this.data;
  }

  set(data: T): void {
    this.save(data);
    this.data = data;
  }

  /** Mutate a clone; a failed save cannot leak an uncommitted change. */
  update(fn: (data: T) => void): void {
    const next = structuredClone(this.data);
    fn(next);
    this.save(next);
    this.data = next;
  }

  private read(): T {
    let contents: string;
    try {
      contents = readFileSync(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.fallback);
      log.error(`cannot read persisted state ${this.path}:`, (error as Error).message);
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      // Nullable stores may intentionally persist either null or a value.
      const sameRoot = this.fallback === null ||
        (Array.isArray(this.fallback) ? Array.isArray(parsed) :
          typeof this.fallback === "object" ? !!parsed && typeof parsed === "object" && !Array.isArray(parsed) :
            typeof parsed === typeof this.fallback);
      if (!sameRoot || (this.validate && !this.validate(parsed))) {
        throw new Error("Invalid persisted state structure");
      }
      return parsed as T;
    } catch (error) {
      log.error(`invalid persisted state ${this.path}; refusing to reset it:`, (error as Error).message);
      throw error;
    }
  }

  private save(data: T): void {
    const tempPath = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tempPath, this.path);
    } catch (error) {
      log.error(`failed to save ${this.path}:`, (error as Error).message);
      throw error;
    } finally {
      try { unlinkSync(tempPath); } catch { /* temp already renamed or never written */ }
    }
  }
}
