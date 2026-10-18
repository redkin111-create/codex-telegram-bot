import { useEffect, useState } from "react";
import { Check, ExternalLink, RefreshCw, ShieldAlert, Trash2, UserRound, UserRoundCheck } from "lucide-react";
import { manageAccount, readAccounts } from "../api.js";
import type { MobileAccount, MobileAccountAction, MobileAccountsSnapshot } from "../types.js";
import { Badge, Button, Card, Input } from "./ui/primitives.js";

type PendingAccountAction =
  | { kind: "switch"; account: MobileAccount }
  | { kind: "forget"; account: MobileAccount }
  | { kind: "rename"; account: MobileAccount }
  | { kind: "deviceLogin" };

export function AccountsPanel({ csrf, onAccountChanged }: { csrf: string; onAccountChanged?: () => void }) {
  const [snapshot, setSnapshot] = useState<MobileAccountsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<PendingAccountAction>();
  const [renameValue, setRenameValue] = useState("");

  async function reload() {
    setLoading(true);
    setError("");
    try { setSnapshot(await readAccounts()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать аккаунты Codex"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (snapshot?.deviceLogin?.status !== "pending") return;
    const timer = window.setInterval(() => {
      void readAccounts().then((next) => {
        if (next.deviceLogin?.status === "completed") {
          onAccountChanged?.();
          setNotice("Codex подтвердил вход. Данные аккаунта обновлены.");
        } else if (next.deviceLogin?.status === "failed") {
          setError("Codex не завершил вход. Проверьте страницу авторизации и попробуйте ещё раз.");
        }
        setSnapshot(next);
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [snapshot?.deviceLogin?.status, onAccountChanged]);

  useEffect(() => { void reload(); }, []);

  async function run(action: MobileAccountAction) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await manageAccount(action, csrf);
      setSnapshot(result.snapshot);
      setNotice(result.message ?? "Изменение сохранено");
      if (action.action === "switch") onAccountChanged?.();
      setPending(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить аккаунт Codex");
    } finally { setSaving(false); }
  }

  function openRename(account: MobileAccount) {
    setRenameValue(account.label);
    setPending({ kind: "rename", account });
  }

  const targetLabel = pending && pending.kind !== "deviceLogin" ? pending.account.label : undefined;

  return <section aria-labelledby="mobile-accounts-title" className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div><h3 id="mobile-accounts-title" className="flex items-center gap-2 text-sm font-semibold"><UserRound size={16} className="text-accent" /> Аккаунты Codex</h3>
        <p className="mt-1 text-xs text-muted">Это общий вход Codex на компьютере.</p></div>
      <Button type="button" variant="ghost" className="min-h-9 px-2" aria-label="Обновить аккаунты Codex" disabled={loading || saving} onClick={() => void reload()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></Button>
    </div>

    {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-xs leading-relaxed text-[#ffc3bd]">{error}</p>}
    {notice && <p role="status" className="rounded-xl border border-[#3d5630] bg-[#20291b] p-3 text-xs leading-relaxed text-[#c7e89a]">{notice}</p>}
    {loading && !snapshot ? <p role="status" className="text-xs text-muted">Читаю сохранённые аккаунты…</p> : null}
    {snapshot && <>
      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-xs text-muted">Сейчас используется</p>
            <p className="mt-1 truncate text-sm font-semibold">{snapshot.activeLabel ?? (snapshot.loggedIn ? "Аккаунт не сохранён" : "Вход не выполнен")}</p>
            {snapshot.activeAccountType && <p className="mt-1 text-[11px] text-muted">{snapshot.activeAccountType}</p>}
          </div>
          <Badge className={snapshot.loggedIn ? "border-[#3d5630] text-[#c7e89a]" : "border-[#6b5a35] text-[#f2c66d]"}>{snapshot.loggedIn ? "Вход выполнен" : "Вход не подтверждён"}</Badge>
        </div>
        <Button type="button" variant="outline" className="min-h-10 w-full" disabled={saving || !snapshot.loggedIn} onClick={() => void run({ action: "saveCurrent" })}>
          <UserRoundCheck size={15} /> Сохранить текущий аккаунт
        </Button>
        {!snapshot.deviceLogin || ["completed", "failed", "cancelled"].includes(snapshot.deviceLogin.status) ? <Button type="button" variant="outline" className="min-h-10 w-full" disabled={saving} onClick={() => setPending({ kind: "deviceLogin" })}>
          Войти в новый аккаунт с телефона
        </Button> : null}
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
          <div><p className="text-xs font-medium">Автопереключение</p><p className="mt-1 text-[11px] text-muted">Пробовать другие аккаунты после ошибок задач</p></div>
          <Button type="button" variant={snapshot.autoRotate ? "default" : "outline"} className="min-h-9 shrink-0 px-3 text-xs" aria-pressed={snapshot.autoRotate} disabled={saving} onClick={() => void run({ action: "setAutoRotate", enabled: !snapshot.autoRotate })}>
            {snapshot.autoRotate ? <><Check size={14} /> Включено</> : "Выключено"}
          </Button>
        </div>
      </Card>

      {snapshot.deviceLogin && <Card className="space-y-3 p-4" aria-live="polite">
        {snapshot.deviceLogin.status === "starting" && <p role="status" className="text-sm">Запрашиваю одноразовый код у Codex…</p>}
        {snapshot.deviceLogin.status === "pending" && <>
          <div><p className="text-sm font-semibold">Завершите вход на телефоне</p><p className="mt-1 text-xs leading-relaxed text-muted">Откройте официальную страницу Codex и введите этот одноразовый код. Он нужен только для этого входа.</p></div>
          <p className="rounded-xl border border-border bg-[#111613] px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.18em]" aria-label="Одноразовый код Codex">{snapshot.deviceLogin.userCode}</p>
          {snapshot.deviceLogin.verificationUrl === "https://auth.openai.com/codex/device" ? <a href={snapshot.deviceLogin.verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-elevated">
            Открыть страницу входа <ExternalLink size={14} />
          </a> : <p role="alert" className="text-xs text-[#ffc3bd]">Ссылка входа не прошла проверку. Отмените запрос.</p>}
          <Button type="button" variant="ghost" className="min-h-9 w-full text-xs text-muted" disabled={saving} onClick={() => void run({ action: "cancelDeviceLogin" })}>Отменить вход</Button>
          <p role="status" className="text-center text-[11px] text-muted">Жду подтверждение от Codex…</p>
        </>}
        {snapshot.deviceLogin.status === "completed" && <p role="status" className="text-sm text-[#c7e89a]">Codex подтвердил вход. Секреты остаются на компьютере.</p>}
        {snapshot.deviceLogin.status === "failed" && <p role="status" className="text-sm text-[#ffc3bd]">Codex не завершил вход. Подробности авторизации не передаются в браузер.</p>}
        {snapshot.deviceLogin.status === "cancelled" && <p role="status" className="text-sm text-muted">Вход отменён.</p>}
      </Card>}

      <div className="space-y-2">
        <p className="px-1 text-xs font-medium text-muted">Сохранённые аккаунты ({snapshot.accounts.length})</p>
        {snapshot.accounts.length ? snapshot.accounts.map((account) => <Card key={account.id} className="space-y-3 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{account.label}</p>
              {account.email && <p className="mt-1 truncate text-[11px] text-muted">{account.email}</p>}
              {account.accountType && <p className="mt-1 text-[11px] text-muted">{account.accountType}</p>}
            </div>
            {account.active && <Badge className="shrink-0 border-[#3d5630] text-[#c7e89a]">Текущий</Badge>}
          </div>
          <div className="flex flex-wrap gap-2">
            {!account.active && <Button type="button" variant="outline" className="min-h-9 flex-1" disabled={saving} onClick={() => setPending({ kind: "switch", account })}>Переключить</Button>}
            <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs" disabled={saving} onClick={() => openRename(account)}>Переименовать</Button>
            <Button type="button" variant="ghost" className="min-h-9 px-3 text-xs text-[#ffc3bd]" aria-label={`Удалить аккаунт ${account.label}`} disabled={saving} onClick={() => setPending({ kind: "forget", account })}><Trash2 size={14} /> Удалить</Button>
          </div>
        </Card>) : <Card className="p-3 text-xs leading-relaxed text-muted">Сохранённых аккаунтов пока нет. Сначала войдите в Codex на компьютере, затем сохраните текущий аккаунт.</Card>}
      </div>
      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted"><ShieldAlert size={14} className="mt-0.5 shrink-0" />Секреты входа не передаются телефону. Их хранит только Codex на этом компьютере.</p>
    </>}

    {pending && <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="account-action-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div><h3 id="account-action-title" className="text-base font-semibold">{pending.kind === "deviceLogin" ? "Войти в другой аккаунт Codex?" : pending.kind === "switch" ? "Сменить аккаунт Codex?" : pending.kind === "forget" ? "Удалить сохранённый аккаунт?" : "Переименовать аккаунт"}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{pending.kind === "deviceLogin"
            ? "Если сейчас выполнен вход, сначала сохраню его копию в локальном списке аккаунтов. Новый вход заменит общий вход Codex на компьютере и повлияет на все сеансы. Активных и ожидающих задач быть не должно. Codex покажет одноразовый код; пароль и токены вводятся только на официальной странице и остаются у Codex."
            : pending.kind === "switch"
            ? `Будет выбран аккаунт «${targetLabel}». Это влияет на все сеансы Codex на компьютере; работающие и ожидающие запросы должны завершиться до смены.`
            : pending.kind === "forget"
              ? `Удалится сохранённая копия входа «${targetLabel}». Текущий вход Codex от этого не изменится.`
              : "Новое название будет видно только в списке аккаунтов."}</p>
        </div>
        {pending.kind === "rename" && <Input aria-label="Новое название аккаунта" maxLength={60} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />}
        {error && <p role="alert" className="text-xs text-[#ffc3bd]">{error}</p>}
        <div className="flex gap-2"><Button type="button" variant="outline" className="min-h-11 flex-1" disabled={saving} onClick={() => { setPending(undefined); setError(""); }}>Отмена</Button>
          <Button type="button" className="min-h-11 flex-1" disabled={saving || (pending.kind === "rename" && !renameValue.trim())} onClick={() => {
            if (pending.kind === "deviceLogin") void run({ action: "startDeviceLogin" });
            else if (pending.kind === "switch") void run({ action: "switch", id: pending.account.id });
            else if (pending.kind === "forget") void run({ action: "forget", id: pending.account.id });
            else void run({ action: "rename", id: pending.account.id, label: renameValue });
          }}>{saving ? "Выполняю…" : pending.kind === "deviceLogin" ? "Начать вход" : pending.kind === "switch" ? "Сменить" : pending.kind === "forget" ? "Удалить" : "Сохранить"}</Button></div>
      </section>
    </div>}
  </section>;
}
