import { useEffect, useState } from "react";
import { Activity, Bot, ChevronDown, CircleHelp, Clock3, Download, ExternalLink, Pause, Play, Plug, Puzzle, RefreshCw, ShieldCheck, Sparkles, Target, Trash2, X } from "lucide-react";
import { readCapabilities } from "../api.js";
import { AccountsPanel } from "./accounts-panel.js";
import { McpConfigPanel } from "./mcp-config-panel.js";
import type { MobileCapabilities, MobileOperation } from "../types.js";
import { Badge, Button, Card, Input, Textarea } from "./ui/primitives.js";

const effortLabel: Record<string, string> = {
  minimal: "Минимум", low: "Низкий", medium: "Средний", high: "Высокий", max: "Максимум",
};

type PluginAction = { kind: "install" | "uninstall"; pluginId: string; };
type PluginInstallNotice = { name: string; installUrl?: string }[];
type SkillAction = { name: string; enabled: boolean };
type MarketplaceAction =
  | { kind: "add"; source: string; refName: string }
  | { kind: "remove" | "upgrade"; marketplaceName: string };

function safeLinkHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.hostname : undefined;
  } catch { return undefined; }
}

function mcpStatusLabel(status: MobileCapabilities["mcpServers"][number]["status"]): string {
  switch (status) {
    case "connected": return "Подключён";
    case "starting": return "Подключается";
    case "authenticationRequired": return "Требуется вход";
    case "notStarted": return "Не запущен";
    case "failed": return "Ошибка подключения";
    case "cancelled": return "Остановлен";
    case "disabled": return "Отключён";
    default: return "Статус неизвестен";
  }
}

function mcpAuthLabel(status: MobileCapabilities["mcpServers"][number]["authStatus"]): string | undefined {
  switch (status) {
    case "notLoggedIn": return "Вход не выполнен";
    case "bearerToken": return "Вход выполнен";
    case "oauth": return "OAuth подключён";
    case "unsupported": return "Авторизация не поддерживается";
    default: return undefined;
  }
}

export function SettingsPanel({ sessionId, connected, csrf, onClose, onOperation, onAccountChanged }: {
  sessionId: string;
  connected: boolean;
  csrf: string;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
  onAccountChanged: () => void;
}) {
  const [capabilities, setCapabilities] = useState<MobileCapabilities>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [goalObjective, setGoalObjective] = useState("");
  const [goalBudget, setGoalBudget] = useState("");
  const [pluginAction, setPluginAction] = useState<PluginAction>();
  const [pluginNotice, setPluginNotice] = useState<PluginInstallNotice>();
  const [skillAction, setSkillAction] = useState<SkillAction>();
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceRef, setMarketplaceRef] = useState("");
  const [marketplaceAction, setMarketplaceAction] = useState<MarketplaceAction>();
  const [marketplaceNotice, setMarketplaceNotice] = useState("");
  const [mcpLoginLinks, setMcpLoginLinks] = useState<Record<string, string>>({});

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const next = await readCapabilities(sessionId);
      setCapabilities(next);
      setMcpLoginLinks((current) => {
        const pending = { ...current };
        for (const server of next.mcpServers) {
          if (server.status === "connected" && (server.authStatus === "oauth" || server.authStatus === "bearerToken")) {
            delete pending[server.name];
          }
        }
        return pending;
      });
      setGoalObjective(next.goal?.objective ?? "");
      setGoalBudget(next.goal?.tokenBudget ? String(next.goal.tokenBudget) : "");
      setError("");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать возможности Codex"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void reload(); }, [sessionId]);

  async function update(op: "setModel" | "setMode" | "setReasoning", field: string, value: string) {
    setSaving(true);
    setError("");
    try {
      await onOperation(op, { sessionId, [field]: value });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройку"); }
    finally { setSaving(false); }
  }

  async function saveGoal() {
    const objective = goalObjective.trim();
    if (!objective) { setError("Напишите цель Codex перед сохранением."); return; }
    const tokenBudget = goalBudget.trim() ? Number(goalBudget) : null;
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 1_000_000_000)) {
      setError("Бюджет должен быть целым числом от 1 до 1 000 000 000 токенов.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onOperation("setGoal", { sessionId, objective, tokenBudget });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить цель"); }
    finally { setSaving(false); }
  }

  async function setGoalStatus(status: "active" | "paused") {
    setSaving(true);
    setError("");
    try {
      await onOperation("setGoal", { sessionId, status });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить статус цели"); }
    finally { setSaving(false); }
  }

  async function clearGoal() {
    setSaving(true);
    setError("");
    try {
      await onOperation("clearGoal", { sessionId });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить цель"); }
    finally { setSaving(false); }
  }

  async function confirmPluginAction() {
    const action = pluginAction;
    const plugin = capabilities?.plugins.find((entry) => entry.id === action?.pluginId);
    if (!action || !plugin) return;
    setSaving(true);
    setError("");
    setPluginNotice(undefined);
    try {
      if (action.kind === "install") {
        const result = await onOperation("installPlugin", { sessionId, pluginId: plugin.id, marketplace: plugin.marketplace }) as {
          authorizationRequired?: Array<{ id: string; name: string; installUrl?: string }>;
        };
        setPluginNotice(result.authorizationRequired?.map(({ name, installUrl }) => ({ name, installUrl })) ?? []);
      } else {
        await onOperation("uninstallPlugin", { sessionId, pluginId: plugin.id });
        setPluginNotice([]);
      }
      setPluginAction(undefined);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить плагин Codex");
    } finally { setSaving(false); }
  }

  async function confirmMarketplaceAction() {
    const action = marketplaceAction;
    if (!action) return;
    setSaving(true);
    setError("");
    setMarketplaceNotice("");
    try {
      if (action.kind === "add") {
        const result = await onOperation("addMarketplace", {
          sessionId, source: action.source, ...(action.refName.trim() ? { refName: action.refName.trim() } : {}),
        }) as { marketplaceName?: unknown; alreadyAdded?: unknown };
        const name = typeof result.marketplaceName === "string" ? result.marketplaceName : "каталог";
        setMarketplaceNotice(result.alreadyAdded === true ? `Каталог ${name} уже был подключён.` : `Каталог ${name} добавлен.`);
      } else if (action.kind === "upgrade") {
        await onOperation("upgradeMarketplace", { sessionId, marketplaceName: action.marketplaceName });
        setMarketplaceNotice(`Каталог ${action.marketplaceName} обновлён.`);
      } else {
        await onOperation("removeMarketplace", { sessionId, marketplaceName: action.marketplaceName });
        setMarketplaceNotice(`Каталог ${action.marketplaceName} удалён.`);
      }
      setMarketplaceAction(undefined);
      setMarketplaceSource("");
      setMarketplaceRef("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить каталог плагинов Codex");
    } finally { setSaving(false); }
  }

  async function confirmSkillAction() {
    const action = skillAction;
    if (!action) return;
    setSaving(true);
    setError("");
    try {
      const result = await onOperation("setSkillEnabled", { sessionId, name: action.name, enabled: action.enabled }) as { enabled?: unknown };
      await reload();
      if (typeof result?.enabled === "boolean" && result.enabled !== action.enabled) {
        setError(result.enabled ? "Codex оставил этот навык включённым из-за своей политики." : "Codex не разрешил включить этот навык.");
      }
      setSkillAction(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить навык Codex");
    } finally { setSaving(false); }
  }

  async function beginMcpOAuth(serverName: string) {
    setSaving(true);
    setError("");
    setMcpLoginLinks((current) => { const pending = { ...current }; delete pending[serverName]; return pending; });
    try {
      const result = await onOperation("mcpOAuthLogin", { sessionId, name: serverName }) as { authorizationUrl?: unknown };
      const authorizationUrl = typeof result?.authorizationUrl === "string" ? result.authorizationUrl : "";
      const host = safeLinkHost(authorizationUrl);
      if (!host) throw new Error("Codex не вернул безопасную HTTPS-ссылку для входа");
      setMcpLoginLinks((current) => ({ ...current, [serverName]: authorizationUrl }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось начать вход в MCP-сервер");
    } finally { setSaving(false); }
  }

  const inputClass = "min-h-11 w-full appearance-none rounded-xl border border-border bg-[#111613] px-3 pr-9 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50";
  const usable = Boolean(capabilities?.online && connected && !saving);
  const selectedPlugin = capabilities?.plugins.find((entry) => entry.id === pluginAction?.pluginId);
  const selectedSkill = capabilities?.skills.find((entry) => entry.name === skillAction?.name);

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="mobile-settings-title" className="safe-area-top safe-area-bottom flex h-full max-h-[100svh] w-full max-w-xl flex-col border-l border-border bg-background shadow-soft">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-4 sm:px-6">
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#a7c278]">Codex</p><h2 id="mobile-settings-title" className="mt-1 text-lg font-semibold">Настройки и возможности</h2></div>
        <div className="flex items-center gap-1"><Button type="button" variant="ghost" className="min-h-10 px-2" aria-label="Обновить данные Codex" disabled={loading || saving} onClick={() => void reload()}><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></Button>
          <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть настройки" onClick={onClose}><X size={19} /></Button></div>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
        {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]">{error}</p>}
        {loading && !capabilities ? <p className="text-sm text-muted">Читаю данные текущего Codex…</p> : null}
        {capabilities && <>
          <AccountsPanel csrf={csrf} onAccountChanged={onAccountChanged} />
          <div className="flex items-center justify-between gap-3">
            <div><p className="text-sm font-semibold">Текущий сеанс</p><p className="mt-1 text-xs text-muted">{connected ? "Подключён для управления" : "История доступна, управление отключено"}</p></div>
            <Badge className={capabilities.online ? "border-[#3d5630] text-[#c7e89a]" : "border-[#733b39] text-[#ffc3bd]"}>{capabilities.online ? "Codex онлайн" : "Codex офлайн"}</Badge>
          </div>
          <Card className="space-y-4 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-accent" /> Параметры ответа</h3>
            <label className="block space-y-1.5"><span className="text-xs text-muted">Модель</span><span className="relative block"><select aria-label="Модель Codex" className={inputClass} value={capabilities.model || "default"} disabled={!usable} onChange={(event) => void update("setModel", "modelId", event.target.value)}><option value="default">По умолчанию</option>{capabilities.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><ChevronDown size={16} className="pointer-events-none absolute right-3 top-3.5 text-muted" /></span></label>
            <label className="block space-y-1.5"><span className="text-xs text-muted">Режим</span><span className="relative block"><select aria-label="Режим Codex" className={inputClass} value={capabilities.mode || "default"} disabled={!usable} onChange={(event) => void update("setMode", "modeId", event.target.value)}><option value="default">По умолчанию</option>{capabilities.modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}</select><ChevronDown size={16} className="pointer-events-none absolute right-3 top-3.5 text-muted" /></span></label>
            <label className="block space-y-1.5"><span className="text-xs text-muted">Глубина рассуждений</span><span className="relative block"><select aria-label="Глубина рассуждений" className={inputClass} value={capabilities.reasoning} disabled={!usable} onChange={(event) => void update("setReasoning", "effort", event.target.value)}>{capabilities.reasoningLevels.map((level) => <option key={level} value={level}>{effortLabel[level] ?? level}</option>)}</select><ChevronDown size={16} className="pointer-events-none absolute right-3 top-3.5 text-muted" /></span></label>
            {!connected && <p className="text-xs leading-relaxed text-muted">Чтобы менять настройки, сначала нажмите «Подключить» в выбранном сеансе.</p>}
          </Card>
          <Card className="space-y-4 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Target size={16} className="text-accent" /> Цель сеанса</h3>
            {capabilities.goalAvailable === false ? <p className="text-xs leading-relaxed text-muted">Эта версия Codex не сообщает цели сеанса.</p> : <>
              {capabilities.goal && <div className="rounded-xl border border-border bg-[#111613] p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{({ active: "Активна", paused: "Приостановлена", blocked: "Заблокирована", usageLimited: "Лимит использования", budgetLimited: "Бюджет исчерпан", complete: "Завершена" } as const)[capabilities.goal.status]}</span>
                  {capabilities.goal.status === "active" ? <Button type="button" variant="outline" className="min-h-8 px-2 text-[11px]" disabled={saving || !capabilities.online} onClick={() => void setGoalStatus("paused")}><Pause size={12} /> Пауза</Button>
                    : capabilities.goal.status === "paused" ? <Button type="button" variant="outline" className="min-h-8 px-2 text-[11px]" disabled={saving || !capabilities.online} onClick={() => void setGoalStatus("active")}><Play size={12} /> Продолжить</Button> : null}
                </div>
                <p className="mt-2 text-xs leading-5 text-muted">Использовано токенов: {capabilities.goal.tokensUsed.toLocaleString("ru-RU")}{capabilities.goal.tokenBudget ? ` из ${capabilities.goal.tokenBudget.toLocaleString("ru-RU")}` : " · без лимита"}</p>
              </div>}
              <label className="block space-y-1.5"><span className="text-xs text-muted">Что Codex должен довести до результата</span><Textarea aria-label="Цель Codex" value={goalObjective} onChange={(event) => setGoalObjective(event.target.value)} maxLength={1000} rows={3} placeholder="Например: исправить ошибки сборки и проверить тесты" disabled={saving || !capabilities.online} /></label>
              <label className="block space-y-1.5"><span className="text-xs text-muted">Лимит токенов · необязательно</span><Input aria-label="Лимит токенов цели" type="number" min={1} max={1_000_000_000} step={1} value={goalBudget} onChange={(event) => setGoalBudget(event.target.value)} placeholder="Без лимита" disabled={saving || !capabilities.online} /></label>
              <div className="flex gap-2">
                <Button type="button" className="flex-1" disabled={saving || !capabilities.online || !goalObjective.trim()} onClick={() => void saveGoal()}>{capabilities.goal ? "Сохранить цель" : "Поставить цель"}</Button>
                {capabilities.goal && <Button type="button" variant="outline" className="min-h-11 px-3 text-[#c58980]" aria-label="Удалить цель сеанса" disabled={saving || !capabilities.online} onClick={() => void clearGoal()}><Trash2 size={15} /> Удалить</Button>}
              </div>
            </>}
          </Card>
          {capabilities.account && <Card className="p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-accent" /> Аккаунт</h3><p className="mt-3 text-sm">{capabilities.account.email || capabilities.account.type}</p><p className="mt-1 text-xs text-muted">{capabilities.account.plan || capabilities.account.type}</p></Card>}
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Activity size={16} className="text-accent" /> Лимиты</h3>
            {capabilities.limits.length ? capabilities.limits.map((limit) => <div key={limit.id} className="space-y-2"><p className="text-xs text-muted">{limit.name}</p>{([limit.primary, limit.secondary].filter(Boolean) as NonNullable<typeof limit.primary>[]).map((window, index) => <div key={index}><div className="mb-1 flex justify-between text-xs"><span>{index === 0 ? "Основной период" : "Дополнительный период"}</span><span>{Math.round(window.usedPercent)}% использовано</span></div><div className="h-1.5 overflow-hidden rounded-full bg-elevated"><div className="h-full rounded-full bg-accent" style={{ width: `${window.usedPercent}%` }} /></div>{window.resetsAt && <p className="mt-1 flex items-center gap-1 text-[11px] text-muted"><Clock3 size={12} /> Сброс: {new Date(window.resetsAt * 1000).toLocaleString()}</p>}</div>)}</div>) : <p className="text-xs text-muted">Информация о лимитах сейчас недоступна.</p>}
          </Card>
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug size={16} className="text-accent" /> MCP-серверы</h3>
            {!capabilities.mcpServersAvailable ? <p className="text-xs text-muted">Состояние MCP-серверов для этого сеанса недоступно.</p>
              : capabilities.mcpServers.length ? <ul className="space-y-2">{capabilities.mcpServers.map((server) => <li key={server.name} className="rounded-xl border border-border bg-[#111613] p-3">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{server.name}</p>{server.serverName && <p className="mt-1 break-words text-[11px] text-muted">{server.serverName}{server.serverVersion ? ` · ${server.serverVersion}` : ""}</p>}</div><Badge>{mcpStatusLabel(server.status)}</Badge></div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted"><span>{server.toolCount} инструментов</span><span>{server.resourceCount} ресурсов</span><span>{server.resourceTemplateCount} шаблонов</span>{mcpAuthLabel(server.authStatus) && <span>{mcpAuthLabel(server.authStatus)}</span>}</div>
                {server.discoveryFailed && <p className="mt-2 text-[11px] text-[#ffc3bd]">Codex сообщил об ошибке списка инструментов. Подробности доступны в локальном Codex.</p>}
                {(server.status === "authenticationRequired" || server.authStatus === "notLoggedIn") && <div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" className="min-h-9 px-3 text-xs" disabled={!usable} onClick={() => void beginMcpOAuth(server.name)}><ShieldCheck size={14} /> Начать вход</Button></div>}
                {mcpLoginLinks[server.name] && safeLinkHost(mcpLoginLinks[server.name]) && <div className="mt-3 space-y-2 rounded-lg border border-border bg-[#111613] p-3" role="status"><p className="text-xs leading-relaxed text-muted">Продолжите вход у провайдера. Перед вводом пароля проверьте адрес: <span className="font-medium text-text">{safeLinkHost(mcpLoginLinks[server.name])}</span>.</p><div className="flex flex-wrap items-center gap-2"><a className="inline-flex min-h-9 items-center gap-1 text-xs text-accent underline" href={mcpLoginLinks[server.name]} target="_blank" rel="noopener noreferrer">Открыть страницу входа <ExternalLink size={12} /></a><Button type="button" variant="ghost" className="min-h-9 px-2 text-xs" disabled={loading || saving} onClick={() => void reload()}>Проверить подключение</Button></div></div>}
                {server.tools.length > 0 && <details className="mt-3 border-t border-border pt-2"><summary className="min-h-8 cursor-pointer py-1 text-xs font-medium">Доступные инструменты ({server.toolCount})</summary><ul className="mt-1 space-y-2">{server.tools.map((tool) => <li key={tool.name} className="rounded-lg bg-[#171d18] p-2"><p className="break-words font-mono text-[11px]">{tool.name}</p>{tool.description && <p className="mt-1 break-words text-[11px] leading-relaxed text-muted">{tool.description}</p>}</li>)}</ul></details>}
              </li>)}</ul> : <p className="text-xs text-muted">В этом сеансе нет подключённых MCP-серверов.</p>}
            <p className="text-[11px] leading-relaxed text-muted">Показано состояние выбранного сеанса. Адреса, параметры инструментов и секреты авторизации не передаются в мобильный интерфейс.</p>
          </Card>
          <McpConfigPanel sessionId={sessionId} canChange={capabilities.online} onOperation={onOperation} onRestarted={reload} />
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Puzzle size={16} className="text-accent" /> Плагины Codex</h3>
            {!capabilities.pluginCatalogAvailable ? <p className="text-xs leading-relaxed text-muted">Эта версия Codex не предоставляет каталог плагинов.</p> : capabilities.plugins.length ? <ul className="space-y-3">{capabilities.plugins.slice(0, 80).map((plugin) => <li key={`${plugin.marketplace}:${plugin.id}`} className="rounded-xl border border-border bg-[#111613] p-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{plugin.name}</p><p className="mt-1 truncate text-[11px] text-muted">{plugin.marketplace}</p></div><Badge>{plugin.installed ? plugin.enabled ? "Установлен" : "Отключён" : plugin.installable ? "Доступен" : "Недоступен"}</Badge></div>
              {plugin.description && <p className="mt-2 text-xs leading-relaxed text-muted">{plugin.description}</p>}
              {plugin.mustShowInstallationInterstitial && plugin.capabilities.length > 0 && <p className="mt-2 text-[11px] text-muted">Возможности: {plugin.capabilities.join(", ")}</p>}
              <div className="mt-3 flex justify-end">{plugin.installed ? <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" disabled={!usable} onClick={() => setPluginAction({ kind: "uninstall", pluginId: plugin.id })}><Trash2 size={14} /> Удалить</Button>
                : plugin.installable ? <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" disabled={!usable} onClick={() => setPluginAction({ kind: "install", pluginId: plugin.id })}><Download size={14} /> Установить</Button> : null}</div>
            </li>)}</ul> : <p className="text-xs text-muted">Каталог плагинов пуст.</p>}
            <p className="text-[11px] leading-relaxed text-muted">Установка и удаление меняют настройки Codex на этом компьютере. Действие доступно только для записи из актуального каталога уже подключённого Codex.</p>
            {pluginNotice && <div role="status" className="rounded-xl border border-border bg-[#111613] p-3 text-xs leading-relaxed">
              {pluginNotice.length ? <><p className="font-semibold">Чтобы завершить настройку плагина, подключите сервис:</p><ul className="mt-2 space-y-2">{pluginNotice.map((app) => <li key={app.name}>{app.installUrl && safeLinkHost(app.installUrl) ? <a className="inline-flex items-center gap-1 text-accent underline" href={app.installUrl} target="_blank" rel="noopener noreferrer">{app.name} · {safeLinkHost(app.installUrl)}<ExternalLink size={12} /></a> : <span>{app.name} · откройте Codex на компьютере для авторизации</span>}</li>)}</ul></> : <p>Изменение плагинов передано Codex.</p>}
            </div>}
          </Card>
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Puzzle size={16} className="text-accent" /> Каталоги плагинов</h3>
            {capabilities.marketplaces.length ? <ul className="space-y-2">{capabilities.marketplaces.map((marketplace) => <li key={marketplace.name} className="rounded-xl border border-border bg-[#111613] p-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{marketplace.name}</p><p className="mt-1 text-[11px] text-muted">{marketplace.pluginCount} плагинов · установлено {marketplace.installedPluginCount}</p></div><Badge>{marketplace.manageable ? "Управляемый" : "Только просмотр"}</Badge></div>
              {marketplace.manageable && <div className="mt-3 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label={`Обновить каталог ${marketplace.name}`} disabled={!usable} onClick={() => setMarketplaceAction({ kind: "upgrade", marketplaceName: marketplace.name })}><RefreshCw size={13} /> Обновить</Button><Button type="button" variant="outline" className="min-h-9 px-3 text-xs text-[#c58980]" aria-label={`Удалить каталог ${marketplace.name}`} disabled={!usable} onClick={() => setMarketplaceAction({ kind: "remove", marketplaceName: marketplace.name })}><Trash2 size={13} /> Удалить</Button></div>}
            </li>)}</ul> : <p className="text-xs text-muted">Каталоги Codex недоступны или не найдены.</p>}
            <label className="block space-y-1.5"><span className="text-xs text-muted">Добавить GitHub-каталог</span><Input aria-label="Адрес каталога плагинов" value={marketplaceSource} onChange={(event) => setMarketplaceSource(event.target.value)} maxLength={2048} placeholder="owner/repo или https://github.com/…" disabled={!usable} /></label>
            <label className="block space-y-1.5"><span className="text-xs text-muted">Ветка или версия · необязательно</span><Input aria-label="Ветка или версия каталога" value={marketplaceRef} onChange={(event) => setMarketplaceRef(event.target.value)} maxLength={200} placeholder="stable" disabled={!usable} /></label>
            <Button type="button" variant="outline" className="w-full" disabled={!usable || !marketplaceSource.trim()} onClick={() => setMarketplaceAction({ kind: "add", source: marketplaceSource.trim(), refName: marketplaceRef })}>Добавить каталог</Button>
            <p className="text-[11px] leading-relaxed text-muted">Codex загрузит GitHub-репозиторий в настройки этого компьютера. Принимайте только знакомые вам каталоги: плагины могут добавлять инструкции и подключения. Для защиты компьютера мобильное добавление ограничено GitHub HTTPS; локальные пути, SSH и другие хосты не принимаются.</p>
            {marketplaceNotice && <p role="status" className="rounded-lg border border-[#3d5630] bg-[#1c2818] p-3 text-xs text-[#c7e89a]">{marketplaceNotice}</p>}
          </Card>
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug size={16} className="text-accent" /> Приложения и подключения</h3>
            {!capabilities.appsAvailable ? <p className="text-xs leading-relaxed text-muted">Эта версия Codex не предоставляет список приложений.</p> : capabilities.apps.length ? <ul className="space-y-3">{capabilities.apps.slice(0, 80).map((app) => <li key={app.id} className="rounded-xl border border-border bg-[#111613] p-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{app.name}</p>{app.description && <p className="mt-1 text-xs leading-relaxed text-muted">{app.description}</p>}</div><Badge>{!app.enabled ? "Отключено" : app.callable ? "Подключено" : app.accessible ? "Доступно" : "Требует входа"}</Badge></div>
              {app.installUrl && !app.accessible && safeLinkHost(app.installUrl) && <a className="mt-2 inline-flex min-h-9 items-center gap-1 text-xs text-accent underline" href={app.installUrl} target="_blank" rel="noopener noreferrer">Подключить · {safeLinkHost(app.installUrl)}<ExternalLink size={12} /></a>}
            </li>)}</ul> : <p className="text-xs text-muted">Приложения не найдены.</p>}
            <p className="text-[11px] leading-relaxed text-muted">Состояние читается у локального Codex. Перед переходом проверьте адрес сервиса и подключайте только знакомые вам службы.</p>
          </Card>
          <Card className="space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Bot size={16} className="text-accent" /> Навыки и агенты</h3>
            {capabilities.skills.length ? <ul className="space-y-3">{capabilities.skills.map((skill, index) => <li key={`${skill.name}:${skill.scope ?? "unknown"}:${index}`} className="rounded-xl border border-border bg-[#111613] p-3">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{skill.name}</p>{skill.description && <p className="mt-1 text-xs leading-relaxed text-muted">{skill.description}</p>}</div><Badge>{skill.enabled ? "Включён" : "Отключён"}</Badge></div>
              <div className="mt-3 flex items-center justify-between gap-2"><p className="text-[11px] text-muted">Область: {skill.scope ?? "неизвестна"}</p>{skill.canToggle && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label={`${skill.enabled ? "Отключить" : "Включить"} навык ${skill.name}`} disabled={!usable} onClick={() => setSkillAction({ name: skill.name, enabled: !skill.enabled })}>{skill.enabled ? "Отключить" : "Включить"}</Button>}</div>
            </li>)}</ul> : <p className="text-xs text-muted">Навыки не найдены.</p>}
            <p className="text-[11px] leading-relaxed text-muted">Изменение сохраняется в настройках Codex на этом компьютере и может повлиять на другие сеансы. Администраторские и встроенные навыки здесь не меняются.</p>
            {capabilities.subagents.length > 0 && <div className="border-t border-border pt-3"><p className="mb-2 text-xs font-semibold text-muted">Подагенты текущего владельца</p><ul className="space-y-2">{capabilities.subagents.map((agent) => <li key={agent.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{agent.name}</span><Badge>{agent.status}</Badge></li>)}</ul></div>}
          </Card>
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted"><CircleHelp size={14} className="mt-0.5 shrink-0" />Список строится из текущего локального runtime. Здесь отображаются только сведения для выбранного владельца, без локальных путей и секретов MCP.</p>
          <p className="text-center text-[10px] text-muted">Обновлено: {new Date(capabilities.checkedAt).toLocaleTimeString()}</p>
        </>}
      </div>
      {pluginAction && selectedPlugin && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
        <section role="alertdialog" aria-modal="true" aria-labelledby="plugin-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
          <div><h3 id="plugin-confirm-title" className="text-base font-semibold">{pluginAction.kind === "install" ? "Установить плагин?" : "Удалить плагин?"}</h3><p className="mt-2 text-sm leading-relaxed text-muted"><span className="font-medium text-text">{selectedPlugin.name}</span> · {selectedPlugin.marketplace}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted">{pluginAction.kind === "install" ? "Codex загрузит плагин из выбранного удалённого каталога. Он может добавлять инструкции и подключать внешние сервисы." : "Плагин будет удалён из настроек Codex на этом компьютере. Это может повлиять на другие сеансы."}</p>
            {selectedPlugin.capabilities.length > 0 && <p className="mt-2 text-xs text-muted">Заявленные возможности: {selectedPlugin.capabilities.join(", ")}</p>}
          </div>
          <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => setPluginAction(undefined)}>Отмена</Button><Button type="button" className="flex-1" disabled={saving || !usable} onClick={() => void confirmPluginAction()}>{saving ? "Выполняю…" : pluginAction.kind === "install" ? "Установить" : "Удалить"}</Button></div>
        </section>
      </div>}
      {skillAction && selectedSkill && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
        <section role="alertdialog" aria-modal="true" aria-labelledby="skill-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
          <div><h3 id="skill-confirm-title" className="text-base font-semibold">{skillAction.enabled ? "Включить навык?" : "Отключить навык?"}</h3><p className="mt-2 break-words text-sm leading-relaxed text-muted"><span className="font-medium text-text">{selectedSkill.name}</span></p>
            <p className="mt-2 text-xs leading-relaxed text-muted">Настройка сохранится в Codex на этом компьютере и может повлиять на другие сеансы. Файл навыка не изменится.</p>
          </div>
          <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => setSkillAction(undefined)}>Отмена</Button><Button type="button" className="flex-1" disabled={saving || !usable} onClick={() => void confirmSkillAction()}>{saving ? "Сохраняю…" : skillAction.enabled ? "Включить" : "Отключить"}</Button></div>
        </section>
      </div>}
      {marketplaceAction && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
        <section role="alertdialog" aria-modal="true" aria-labelledby="marketplace-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
          <div><h3 id="marketplace-confirm-title" className="text-base font-semibold">{marketplaceAction.kind === "add" ? "Добавить каталог?" : marketplaceAction.kind === "upgrade" ? "Обновить каталог?" : "Удалить каталог?"}</h3>
            <p className="mt-2 break-all text-sm text-text">{marketplaceAction.kind === "add" ? marketplaceAction.source : marketplaceAction.marketplaceName}{marketplaceAction.kind === "add" && marketplaceAction.refName.trim() ? ` · ${marketplaceAction.refName.trim()}` : ""}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted">{marketplaceAction.kind === "add" ? "Codex загрузит список плагинов по этому адресу. Код плагинов не запускается этой кнопкой, но их инструкции и инструменты могут повлиять на последующие задачи." : marketplaceAction.kind === "upgrade" ? "Codex получит новую версию этого каталога. Состав и инструкции плагинов могут измениться и затронуть другие сеансы." : "Codex удалит запись каталога из настроек. Плагины из него могут перестать быть доступными в других сеансах."}</p>
          </div>
          <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => setMarketplaceAction(undefined)}>Отмена</Button><Button type="button" className="flex-1" disabled={saving || !usable} onClick={() => void confirmMarketplaceAction()}>{saving ? "Выполняю…" : marketplaceAction.kind === "add" ? "Добавить" : marketplaceAction.kind === "upgrade" ? "Обновить" : "Удалить"}</Button></div>
        </section>
      </div>}
    </section>
  </div>;
}
