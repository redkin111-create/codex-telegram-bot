/**
 * Auto-rotate-on-give-up. When a turn exhausts its retries (and auto-fork can't
 * recover it), the runtime can cycle through the OTHER saved Codex accounts,
 * retrying the same prompt on each — useful when the active account is
 * throttled, out of quota, or its backend keeps returning transient errors.
 *
 * The rotation is bounded to a SINGLE pass over the saved accounts (no infinite
 * loop): each account is tried once; the first that succeeds wins and stays
 * active, otherwise the runtime reports the error gathered from every account.
 *
 * Account switching is process-global (one machine → one active Codex login),
 * so a rotation restarts the shared agent and affects every chat — intended,
 * since the whole point is to move everyone onto a working login.
 */
import type { AcpClient } from "../acp/client.js";
import type { AccountManager } from "../app/accounts.js";
import type { UsageService } from "../app/usage.js";

export interface RotationTarget {
  id: string;
  label: string;
}

export interface AccountRotator {
  /** Whether auto-rotate is switched on. */
  enabled(): boolean;
  /** Saved accounts to try, EXCLUDING the one that's currently active. */
  targets(): Promise<RotationTarget[]>;
  /** Make a saved account active (copy token + restart agent). Throws on error. */
  activate(id: string): Promise<void>;
  /** Hold the process-global credential lock through switch, restart and use. */
  runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

export class AccountRotatorImpl implements AccountRotator {
  private activationTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly accounts: AccountManager,
    private readonly acp: AcpClient,
    private readonly usage: UsageService,
  ) {}

  enabled(): boolean {
    return this.accounts.autoRotateEnabled();
  }

  async targets(): Promise<RotationTarget[]> {
    const list = this.accounts.list();
    const acct = await this.usage.account().catch(() => undefined);
    const activeId = this.accounts.matchActive(acct?.key || acct?.email)?.id;
    return list.filter((a) => a.id !== activeId).map((a) => ({ id: a.id, label: a.label }));
  }

  async activate(id: string): Promise<void> {
    return this.runExclusive(id, async () => undefined);
  }

  async runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.activationTail;
    this.activationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.activateExclusive(id);
      return await operation();
    } finally {
      release();
    }
  }

  private async activateExclusive(id: string): Promise<void> {
    const rollback = await this.accounts.activeBytes();
    await this.accounts.switchTo(id);
    try {
      await this.acp.restart();
    } catch (error) {
      await this.accounts.restoreActive(rollback).catch(() => undefined);
      await this.acp.restart().catch(() => undefined);
      throw error;
    }
  }
}
