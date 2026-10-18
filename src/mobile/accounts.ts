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
  deviceLogin?: MobileDeviceLoginSnapshot;
}

export interface MobileDeviceLoginSnapshot {
  status: "starting" | "pending" | "completed" | "failed" | "cancelled";
  startedAt: string;
  verificationUrl?: string;
  userCode?: string;
}

const SAFE_DEVICE_LOGIN_ERRORS = new Set([
  "Codex вернул неверный ID входа",
  "Codex вернул неверный ответ для входа по коду",
  "Codex вернул небезопасную ссылку входа",
  "Codex вернул неверный одноразовый код",
  "Не удалось сохранить текущий вход. Новый вход не начинался.",
]);

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
  private deviceLogin?: MobileDeviceLoginSnapshot & { loginId?: string };

  constructor(private readonly options: MobileAccountControllerOptions) {
    this.options.acp.on("notification", (method, params) => this.onNotification(method, params));
  }

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
      ...(this.deviceLogin ? { deviceLogin: this.publicDeviceLogin() } : {}),
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
      case "startDeviceLogin":
        return this.startDeviceLogin(ownerId);
      case "cancelDeviceLogin":
        return this.cancelDeviceLogin(ownerId);
      default:
        throw new Error("Неизвестное действие с аккаунтом");
    }
  }

  private async startDeviceLogin(ownerId: number): Promise<MobileAccountActionResult> {
    if (this.deviceLogin?.status === "starting" || this.deviceLogin?.status === "pending") {
      throw new Error("Вход Codex по одноразовому коду уже выполняется");
    }
    this.requireIdleForAccountChange();
    const startedAt = new Date().toISOString();
    this.deviceLogin = { status: "starting", startedAt };
    try {
      return await this.options.rotator.runLocked(async () => {
        this.requireIdleForAccountChange();
        if (await this.options.usage.isLoggedIn()) {
          try { await this.options.accounts.captureCurrent(await this.options.usage.account().catch(() => undefined)); }
          catch { throw new Error("Не удалось сохранить текущий вход. Новый вход не начинался."); }
        }
        const login = await this.options.acp.startChatgptDeviceCodeLogin();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(login.loginId)) {
          throw new Error("Codex вернул неверный ID входа");
        }
        let verificationUrl: URL;
        try { verificationUrl = new URL(login.verificationUrl); }
        catch {
          await this.options.acp.cancelAccountLogin(login.loginId).catch(() => undefined);
          throw new Error("Codex вернул небезопасную ссылку входа");
        }
        if (verificationUrl.protocol !== "https:" || verificationUrl.hostname !== "auth.openai.com" ||
            verificationUrl.pathname !== "/codex/device" || verificationUrl.username || verificationUrl.password ||
            verificationUrl.search || verificationUrl.hash) {
          await this.options.acp.cancelAccountLogin(login.loginId).catch(() => undefined);
          throw new Error("Codex вернул небезопасную ссылку входа");
        }
        if (!/^[A-Z0-9-]{4,32}$/.test(login.userCode)) {
          await this.options.acp.cancelAccountLogin(login.loginId).catch(() => undefined);
          throw new Error("Codex вернул неверный одноразовый код");
        }
        this.deviceLogin = {
          loginId: login.loginId,
          status: "pending",
          startedAt,
          verificationUrl: verificationUrl.toString(),
          userCode: login.userCode,
        };
        return { snapshot: await this.snapshot(ownerId), message: "Codex показал одноразовый код. Завершите вход в браузере телефона." };
      });
    } catch (error) {
      this.deviceLogin = undefined;
      const message = error instanceof Error ? error.message : "";
      if (SAFE_DEVICE_LOGIN_ERRORS.has(message)) throw new Error(message);
      throw new Error("Не удалось начать вход Codex по одноразовому коду. Проверьте, поддерживает ли установленная версия этот способ входа.");
    }
  }

  private async cancelDeviceLogin(ownerId: number): Promise<MobileAccountActionResult> {
    this.requireOwner(ownerId);
    if (this.deviceLogin?.status !== "pending" || !this.deviceLogin.loginId) {
      throw new Error("Нет ожидающего входа Codex, который можно отменить");
    }
    try { await this.options.acp.cancelAccountLogin(this.deviceLogin.loginId); }
    catch { throw new Error("Не удалось отменить вход Codex. Повторите попытку."); }
    this.deviceLogin = { status: "cancelled", startedAt: this.deviceLogin.startedAt };
    return { snapshot: await this.snapshot(ownerId), message: "Вход Codex отменён" };
  }

  private requireIdleForAccountChange(): void {
    if (this.options.acp.hasInflightPrompt()) throw new Error("Codex занят. Дождитесь завершения текущей задачи перед входом в другой аккаунт");
    if (this.options.registry.hasPendingWork()) throw new Error("В Codex есть ожидающие запросы. Выполните их или удалите перед сменой аккаунта");
  }

  private onNotification(method: string, value: unknown): void {
    if (method !== "account/login/completed" || !this.deviceLogin || this.deviceLogin.status !== "pending" ||
        !value || typeof value !== "object") return;
    const notification = value as { loginId?: unknown; success?: unknown };
    if (notification.loginId !== this.deviceLogin.loginId || typeof notification.success !== "boolean") return;
    this.deviceLogin = {
      status: notification.success ? "completed" : "failed",
      startedAt: this.deviceLogin.startedAt,
    };
  }

  private publicDeviceLogin(): MobileDeviceLoginSnapshot {
    const login = this.deviceLogin!;
    return {
      status: login.status,
      startedAt: login.startedAt,
      ...(login.status === "pending" && login.verificationUrl ? { verificationUrl: login.verificationUrl } : {}),
      ...(login.status === "pending" && login.userCode ? { userCode: login.userCode } : {}),
    };
  }

  private async switchAccount(ownerId: number, id: string): Promise<MobileAccountActionResult> {
    const target = this.options.accounts.get(id);
    if (!target) throw new Error("Сохранённый аккаунт не найден");
    if (this.deviceLogin?.status === "starting" || this.deviceLogin?.status === "pending") {
      throw new Error("Сначала завершите или отмените вход по одноразовому коду");
    }
    this.requireIdleForAccountChange();

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
