/**
 * Shared dependencies passed to all handlers, plus a small per-chat cache for
 * mapping inline-keyboard buttons back to long values (project paths).
 */
import type { Api } from "grammy";
import { randomBytes } from "node:crypto";
import type { AcpClient } from "../acp/client.js";
import type { CodexSkillInfo } from "../acp/codex-protocol.js";
import type { AccountManager } from "../app/accounts.js";
import type { AccountRotator } from "./account-rotator.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import type { SttService } from "../app/stt.js";
import type { UsageService } from "../app/usage.js";
import type { ProjectEntry, ProjectManager } from "../projects/manager.js";
import type { SessionMeta } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { TaskRunner } from "../tasks/runner.js";
import type { TaskStore } from "../tasks/store.js";
import type { StatusPanel } from "./menu/status-panel.js";
import type { Ephemeral } from "./menu/ephemeral.js";
import type { RuntimeRegistry } from "./registry.js";
import type { TaskWizard } from "./wizard/task-wizard.js";

export interface BotDeps {
  api: Api;
  cfg: AppConfig;
  acp: AcpClient;
  registry: RuntimeRegistry;
  store: SessionStore;
  projects: ProjectManager;
  menuCache: MenuCache;
  settings: SettingsStore;
  statusPanel: StatusPanel;
  ephemeral: Ephemeral;
  tasks: TaskStore;
  taskRunner: TaskRunner;
  wizard: TaskWizard;
  stt: SttService;
  usage: UsageService;
  accounts: AccountManager;
  accountRotator: AccountRotator;
}

/** Caches the last project list shown per chat for callback resolution. */
export class MenuCache {
  private readonly projectLists = new Map<number, { token: string; entries: ProjectEntry[] }>();
  private readonly sessionLists = new Map<number, { token: string; metas: SessionMeta[]; heading: string }>();
  private readonly modelLists = new Map<number, { token: string; entries: Array<{ modelId: string; name: string; description?: string }> }>();
  private readonly skillLists = new Map<number, { token: string; entries: CodexSkillInfo[] }>();
  private readonly projectSearchUntil = new Map<number, number>();

  setProjects(chatId: number, entries: ProjectEntry[]): string {
    const token = this.createToken();
    this.projectLists.set(chatId, { token, entries });
    return token;
  }

  getProject(chatId: number, index: number, token?: string): ProjectEntry | undefined {
    const cached = this.projectLists.get(chatId);
    if (!cached || (token !== undefined && token !== cached.token)) return undefined;
    return cached.entries[index];
  }

  /** The full (sorted) project list, for paging the picker. */
  getProjects(chatId: number, token?: string): ProjectEntry[] | undefined {
    const cached = this.projectLists.get(chatId);
    return cached && (token === undefined || token === cached.token) ? cached.entries : undefined;
  }

  getProjectToken(chatId: number): string | undefined {
    return this.projectLists.get(chatId)?.token;
  }

  beginProjectSearch(chatId: number): void {
    this.projectSearchUntil.set(chatId, Date.now() + 2 * 60_000);
  }

  consumeProjectSearch(chatId: number): boolean {
    const until = this.projectSearchUntil.get(chatId);
    this.projectSearchUntil.delete(chatId);
    return until !== undefined && until >= Date.now();
  }

  clearProjectSearch(chatId: number): void {
    this.projectSearchUntil.delete(chatId);
  }

  /** Remember the session set + heading currently being paged for a chat. */
  setSessions(chatId: number, metas: SessionMeta[], heading: string): string {
    const token = this.createToken();
    this.sessionLists.set(chatId, { token, metas, heading });
    return token;
  }

  getSessions(chatId: number, token?: string): { token: string; metas: SessionMeta[]; heading: string } | undefined {
    const cached = this.sessionLists.get(chatId);
    return cached && (token === undefined || token === cached.token) ? cached : undefined;
  }

  getSession(chatId: number, token: string, index: number): SessionMeta | undefined {
    return this.getSessions(chatId, token)?.metas[index];
  }

  setModels(chatId: number, entries: Array<{ modelId: string; name: string; description?: string }>): string {
    const token = this.createToken();
    this.modelLists.set(chatId, { token, entries });
    return token;
  }

  getModels(chatId: number, token: string): Array<{ modelId: string; name: string; description?: string }> | undefined {
    const cached = this.modelLists.get(chatId);
    return cached?.token === token ? cached.entries : undefined;
  }

  getModel(chatId: number, token: string, index: number): { modelId: string; name: string; description?: string } | undefined {
    return this.getModels(chatId, token)?.[index];
  }

  setSkills(chatId: number, entries: CodexSkillInfo[]): string {
    const token = this.createToken();
    this.skillLists.set(chatId, { token, entries });
    return token;
  }

  getSkills(chatId: number, token: string): CodexSkillInfo[] | undefined {
    const cached = this.skillLists.get(chatId);
    return cached?.token === token ? cached.entries : undefined;
  }

  getSkill(chatId: number, token: string, index: number): CodexSkillInfo | undefined {
    return this.getSkills(chatId, token)?.[index];
  }

  createToken(): string {
    return randomBytes(8).toString("hex");
  }
}
