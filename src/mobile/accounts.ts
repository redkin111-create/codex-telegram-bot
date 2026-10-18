import type { AcpClient } from "../acp/client.js";
import type { AccountManager, StoredAccount } from "../app/accounts.js";
import type { UsageService } from "../app/usage.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import type { AccountRotator } from "../bot/account-rotator.js";

export interface MobileAccountSummary {
  id: string;
  label: string;
  email?: string;
  accountType?: string;
  savedAt: string;
  active: boolean;
}

export interface MobileAccountsSnapshot {
  loggedIn: boolean;
  activeAccountId?: string;
  activeLabel?: string;
  activeAccountType?: string;
  autoRotate: boolean;
  accounts: MobileAccountSummary[];
}

export interface MobileAccountActionResult {
  snapshot: MobileAccountsSnapshot;
  message?: string;
}

export interface MobileAccountControllerOptions {
  allowedOwners: ReadonlySet<string>;
  accounts: AccountManager;
  usage: UsageService;
  rotator: AccountRotator;
  acp: AcpClient;
  registry: RuntimeRegistry;
}

function accountSummary(account: StoredAccount, active: boolean): MobileAccountSummary {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.accountType ? { accountType: account.accountType } : {}),
    savedAt: account.savedAt,
    active,
  };
}

function accountId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_-]{8,80}$/i.test(value)) {
    throw new Error("Неверный ID аккаунта");
  }
  return value;
}

function accountLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Укажите название аккаунта");
  const label = value.trim();
  if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error("Название аккаунта должно содержать от 1 до 60 безопасных символов");
  }
  return label;
}

export class MobileAccountController {
  constructor(private readonly options: MobileAccountControllerOptions) {}

  async snapshot(ownerId: number): Promise<MobileAccountsSnapshot> {
    this.requireOwner(ownerId);
    const [active, loggedIn] = await Promise.all([
      this.options.usage.account().catch(() => undefined),
      this.options.usage.isLoggedIn().catch(() => false),
    ]);
    const activeKey = active?.key || active?.email;
    const activeId = this.options.accounts.matchActive(activeKey)?.id;
    return {
      loggedIn,
      ...(activeId ? { activeAccountId: activeId } : {}),
      ...(active?.email || active?.accountType ? { activeLabel: active.email || active.accountType } : {}),
      ...(active?.accountType ? { activeAccountType: active.accountType } : {}),
      autoRotate: this.options.accounts.autoRotateEnabled(),
      accounts: this.options.accounts.list().map((account) => accountSummary(account, account.id === activeId)),
    };
  }

  async execute(ownerId: number, value: unknown): Promise<MobileAccountActionResult> {
    this.requireOwner(ownerId);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Неверное действие с аккаунтом");
    const body = value as Record<string, unknown>;
    switch (body.action) {
      case "saveCurrent": {
        if (!(await this.options.usage.isLoggedIn())) throw new Error("На этом компьютере нет активного входа в Codex");
        await this.options.accounts.captureCurrent(await this.options.usage.account().catch(() => undefined));
        return { snapshot: await this.snapshot(ownerId), message: "Текущий аккаунт сохранён" };
      }
      case "rename": {
        const id = accountId(body.id);
        const label = accountLabel(body.label);
        if (!this.options.accounts.rename(id, label)) throw new Error("Сохранённый аккаунт не найден");
        return { snapshot: await this.snapshot(ownerId), message: "Название аккаунта изменено" };
      }
      case "forget": {
        const id = accountId(body.id);
        if (!(await this.options.accounts.forget(id))) throw new Error("Сохранённый аккаунт не найден");
        return { snapshot: await this.snapshot(ownerId), message: "Сохранённый аккаунт удалён" };
      }
      case "setAutoRotate": {
        if (typeof body.enabled !== "boolean") throw new Error("Укажите состояние автопереключения аккаунтов");
        this.options.accounts.setAutoRotate(body.enabled);
        return { snapshot: await this.snapshot(ownerId), message: body.enabled ? "Автопереключение включено" : "Автопереключение выключено" };
      }
      case "switch":
        return this.switchAccount(ownerId, accountId(body.id));
      default:
        throw new Error("Неизвестное действие с аккаунтом");
    }
  }

  private async switchAccount(ownerId: number, id: string): Promise<MobileAccountActionResult> {
    const target = this.options.accounts.get(id);
    if (!target) throw new Error("Сохранённый аккаунт не найден");
    if (this.options.acp.hasInflightPrompt()) throw new Error("Codex занят. Дождитесь завершения текущей задачи перед сменой аккаунта");
    if (this.options.registry.hasPendingWork()) throw new Error("В Codex есть ожидающие запросы. Выполните их или удалите перед сменой аккаунта");

    const current = await this.options.usage.account().catch(() => undefined);
    const activeId = this.options.accounts.matchActive(current?.key || current?.email)?.id;
    if (activeId === id) return { snapshot: await this.snapshot(ownerId), message: `Уже выбран аккаунт ${target.label}` };

    // Preserve the current login before overwriting the shared auth.json. When
    // Codex is already logged out, switching to a saved account is still a
    // valid recovery action and there is nothing usable to snapshot.
    if (await this.options.usage.isLoggedIn()) await this.options.accounts.captureCurrent(current);
    const loggedIn = await this.options.rotator.runExclusive(id, () => this.options.usage.isLoggedIn());
    return {
      snapshot: await this.snapshot(ownerId),
      message: loggedIn
        ? `Выбран аккаунт ${target.label}. Сеансы Codex подключатся при следующем запросе.`
        : `Аккаунт ${target.label} выбран, но Codex не подтвердил вход. Проверьте авторизацию на компьютере.`,
    };
  }

  private requireOwner(ownerId: number): void {
    if (!Number.isSafeInteger(ownerId) || !this.options.allowedOwners.has(String(ownerId))) {
      throw new Error("Доступ к аккаунтам запрещён");
    }
  }
}
