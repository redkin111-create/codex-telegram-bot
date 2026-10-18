import { useEffect, useRef, useState } from "react";
import { Plug, Plus, RefreshCw, RotateCcw, ShieldAlert, X } from "lucide-react";
import type { MobileOperation } from "../types.js";
import { Badge, Button, Card, Input } from "./ui/primitives.js";

type McpConfigEntry = { name: string; scope: "global" | "workspace"; enabled: boolean; transport: "http" | "stdio" | "unknown" };
type McpDraftBase = { name: string; scope: "global" | "workspace" };
type McpServerDraft = McpDraftBase & (
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http"; url: string; bearerTokenEnvVar?: string }
);
type McpFormState = McpDraftBase & {
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  url: string;
  bearerTokenEnvVar: string;
  envRows: Array<{ id: number; name: string; value: string }>;
};
type McpConfigAction = { name: string; enabled: boolean } | { restart: true } | { add: McpServerDraft };
const newDraft = (): McpFormState => ({
  name: "", scope: "workspace", transport: "stdio", command: "", argsText: "", url: "", bearerTokenEnvVar: "", envRows: [],
});

function safeLinkHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.hostname : undefined;
  } catch { return undefined; }
}

export function McpConfigPanel({ sessionId, canChange, onOperation, onRestarted }: {
  sessionId: string;
  canChange: boolean;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
  onRestarted: () => Promise<void>;
}) {
  const [servers, setServers] = useState<McpConfigEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [action, setAction] = useState<McpConfigAction>();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<McpFormState>(newDraft);
  const nextEnvId = useRef(0);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const result = await onOperation("listMcpConfig", { sessionId });
      if (!Array.isArray(result)) throw new Error("Codex вернул неверный список MCP-серверов");
      setServers(result as McpConfigEntry[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось прочитать настройки MCP");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    void reload();
    setAdding(false);
    setDraft(newDraft());
    setAction(undefined);
  }, [sessionId]);

  function prepareAdd() {
    setError("");
    const name = draft.name.trim();
    if (!name) { setError("Введите имя MCP-сервера."); return; }
    if (draft.transport === "stdio") {
      const env: Record<string, string> = {};
      for (const row of draft.envRows) {
        const key = row.name.trim();
        if (!key && !row.value) continue;
        if (!key || !row.value) { setError("Заполните имя и значение каждой переменной среды."); return; }
        if (Object.hasOwn(env, key)) { setError(`Переменная ${key} указана дважды.`); return; }
        env[key] = row.value;
      }
      if (!draft.command.trim()) { setError("Укажите команду для запуска MCP-сервера."); return; }
      setAction({ add: { name, scope: draft.scope, transport: "stdio", command: draft.command.trim(), args: draft.argsText.split("\n").filter((arg) => arg.length > 0), env } });
    } else {
      if (!draft.url.trim()) { setError("Укажите адрес MCP-сервера."); return; }
      setAction({ add: {
        name, scope: draft.scope, transport: "http", url: draft.url.trim(),
        ...(draft.bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() } : {}),
      } });
    }
  }

  async function confirmAction() {
    const selected = action;
    if (!selected) return;
    setSaving(true);
    setError("");
    try {
      if ("restart" in selected) {
        await onOperation("restartCodex", { sessionId });
        setRestartRequired(false);
        setAction(undefined);
        await onRestarted();
      } else if ("add" in selected) {
        const result = await onOperation("addMcpConfigServer", { sessionId, ...selected.add }) as { restartRequired?: unknown };
        if (result?.restartRequired === true) setRestartRequired(true);
        setAction(undefined);
        setAdding(false);
        setDraft(newDraft());
        await reload();
      } else {
        const result = await onOperation("setMcpConfigEnabled", { sessionId, name: selected.name, enabled: selected.enabled }) as { restartRequired?: unknown };
        if (result?.restartRequired === true) setRestartRequired(true);
        setAction(undefined);
        await reload();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Codex не выполнил действие MCP");
    } finally { setSaving(false); }
  }

  const selectedServer = action && "name" in action ? servers.find((server) => server.name === action.name) : undefined;
  const scopeLabel = (scope: "global" | "workspace") => scope === "workspace" ? "только в этом проекте" : "во всех проектах Codex";

  return <>
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug size={16} className="text-accent" /> Настройки MCP</h3>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" aria-label="Добавить MCP-сервер" className="min-h-9 px-2 text-xs" disabled={!canChange || saving} onClick={() => { setAdding((value) => !value); setAction(undefined); setError(""); }}><Plus size={15} /> Добавить</Button>
          <Button type="button" variant="ghost" aria-label="Обновить настройки MCP" className="min-h-9 px-2" disabled={loading || saving} onClick={() => void reload()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></Button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-xs leading-relaxed text-[#ffc3bd]">{error}</p>}
      {adding && <div className="space-y-3 rounded-xl border border-border bg-[#111613] p-3">
        <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">Новый MCP-сервер</h4><Button type="button" variant="ghost" aria-label="Закрыть форму MCP" className="min-h-9 px-2" onClick={() => { setAdding(false); setError(""); }}><X size={16} /></Button></div>
        <label className="block space-y-1 text-xs text-muted"><span>Имя сервера</span><Input autoComplete="off" maxLength={128} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="например, docs" /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1 text-xs text-muted"><span>Область</span><select className="min-h-11 w-full rounded-xl border border-border bg-[#111613] px-3 text-sm text-text" value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as McpFormState["scope"] })}><option value="workspace">Этот проект</option><option value="global">Все проекты</option></select></label>
          <label className="block space-y-1 text-xs text-muted"><span>Подключение</span><select className="min-h-11 w-full rounded-xl border border-border bg-[#111613] px-3 text-sm text-text" value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as McpFormState["transport"] })}><option value="stdio">Локальная команда</option><option value="http">HTTPS-сервер</option></select></label>
        </div>
        {draft.transport === "stdio" ? <>
          <label className="block space-y-1 text-xs text-muted"><span>Команда</span><Input autoComplete="off" maxLength={512} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
          <label className="block space-y-1 text-xs text-muted"><span>Аргументы, по одному на строку</span><textarea className="min-h-20 w-full resize-y rounded-xl border border-border bg-[#111613] px-3 py-3 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" autoComplete="off" maxLength={262144} value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} placeholder={"-y\n@example/server"} /></label>
          <div className="space-y-2"><div className="flex items-center justify-between gap-2"><p className="text-xs text-muted">Переменные среды (значения сохранятся в config.toml на компьютере)</p><Button type="button" variant="outline" className="min-h-9 px-2 text-[11px]" disabled={draft.envRows.length >= 32} onClick={() => setDraft({ ...draft, envRows: [...draft.envRows, { id: nextEnvId.current++, name: "", value: "" }] })}><Plus size={13} /> Добавить</Button></div>
            {draft.envRows.map((row) => <div key={row.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_36px] gap-1"><Input autoComplete="off" aria-label="Имя переменной среды" maxLength={128} value={row.name} onChange={(event) => setDraft({ ...draft, envRows: draft.envRows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item) })} placeholder="API_TOKEN" /><Input type="password" autoComplete="new-password" aria-label="Секрет переменной среды" maxLength={8192} value={row.value} onChange={(event) => setDraft({ ...draft, envRows: draft.envRows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item) })} placeholder="Секретное значение" /><Button type="button" variant="ghost" aria-label="Удалить переменную среды" className="min-h-9 px-2" onClick={() => setDraft({ ...draft, envRows: draft.envRows.filter((item) => item.id !== row.id) })}><X size={15} /></Button></div>)}
          </div>
          <p className="text-[11px] leading-relaxed text-[#eadcae]">Команда будет запущена на компьютере Codex после отдельного перезапуска. Добавляйте только команды, которым доверяете.</p>
        </> : <>
          <label className="block space-y-1 text-xs text-muted"><span>Адрес MCP</span><Input autoComplete="url" inputMode="url" maxLength={2048} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example.com/mcp" /></label>
          <label className="block space-y-1 text-xs text-muted"><span>Имя переменной среды с bearer-токеном (не сам токен)</span><Input autoComplete="off" maxLength={128} value={draft.bearerTokenEnvVar} onChange={(event) => setDraft({ ...draft, bearerTokenEnvVar: event.target.value })} placeholder="MCP_ACCESS_TOKEN" /></label>
          <p className="text-[11px] leading-relaxed text-muted">Удалённые серверы должны использовать HTTPS. HTTP разрешён только для localhost. Адрес целиком сохранится в config.toml; не вставляйте в него секретные query-параметры — задайте токен через переменную среды.</p>
        </>}
        <p className="text-[11px] text-muted">Область: {scopeLabel(draft.scope)}.</p>
        <Button type="button" className="w-full" disabled={!canChange || saving} onClick={prepareAdd}>Проверить и продолжить</Button>
      </div>}
      {loading && servers.length === 0 ? <p className="text-xs text-muted">Читаю локальные настройки…</p>
        : servers.length ? <ul className="space-y-2">{servers.map((server) => <li key={`${server.scope}:${server.name}`} className="rounded-xl border border-border bg-[#111613] p-3">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{server.name}</p><p className="mt-1 text-[11px] text-muted">{server.scope === "workspace" ? "Проект" : "Все проекты"} · {server.transport === "stdio" ? "локальный процесс" : server.transport === "http" ? "HTTP" : "тип неизвестен"}</p></div><Badge className={server.enabled ? "border-[#3d5630] text-[#c7e89a]" : "border-[#733b39] text-[#ffc3bd]"}>{server.enabled ? "Включён" : "Отключён"}</Badge></div>
          <div className="mt-3 flex justify-end"><Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label={`${server.enabled ? "Отключить" : "Включить"} MCP ${server.name}`} disabled={!canChange || saving} onClick={() => setAction({ name: server.name, enabled: !server.enabled })}>{server.enabled ? "Отключить" : "Включить"}</Button></div>
        </li>)}</ul> : <p className="text-xs text-muted">Настроенных MCP-серверов нет.</p>}
      {restartRequired && <div className="space-y-2 rounded-xl border border-[#705d31] bg-[#2a2517] p-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-[#eadcae]"><ShieldAlert size={15} className="mt-0.5 shrink-0" />Настройка сохранена. Чтобы применить её, перезапустится общий Codex runtime и подключённые сеансы переподключатся.</p>
        <Button type="button" variant="outline" className="min-h-10 w-full text-xs" disabled={!canChange || saving} onClick={() => setAction({ restart: true })}><RotateCcw size={14} /> Применить с перезапуском Codex</Button>
      </div>}
      <p className="text-[11px] leading-relaxed text-muted">Показываются только имена, область и тип. Команды, адреса, параметры и секреты не возвращаются браузеру из списка MCP.</p>
      {!canChange && <p className="text-[11px] text-muted">Чтобы изменить настройки, подключите Codex к сети.</p>}
    </Card>
    {action && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="mcp-config-confirm-title" className="safe-area-bottom max-h-[85dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        {"restart" in action ? <div><h3 id="mcp-config-confirm-title" className="text-base font-semibold">Перезапустить Codex?</h3><p className="mt-2 text-sm leading-relaxed text-muted">Перезапустится общий Codex runtime на компьютере. Все подключённые сеансы переподключатся. Дождитесь завершения активных задач и очистите очередь перед подтверждением.</p></div>
          : "add" in action ? <div><h3 id="mcp-config-confirm-title" className="text-base font-semibold">Добавить MCP-сервер?</h3><p className="mt-2 text-sm leading-relaxed text-muted"><span className="font-medium text-text">{action.add.name}</span> · {scopeLabel(action.add.scope)}</p>
            {action.add.transport === "stdio" ? <><pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-[#111613] p-3 text-xs text-text">{[action.add.command, ...action.add.args].join("\n")}</pre><p className="mt-2 text-xs text-muted">Переменных среды: {Object.keys(action.add.env).length}. Значения не показываются.</p><p className="mt-2 text-xs leading-relaxed text-[#eadcae]">После отдельного перезапуска эта команда будет выполняться на компьютере.</p></>
              : <><p className="mt-3 text-sm text-text">HTTPS-сервер: {safeLinkHost(action.add.url) ?? "адрес не прошёл проверку"}</p><p className="mt-2 text-xs text-muted">Путь, параметры адреса и токен не показываются.</p></>}</div>
          : <div><h3 id="mcp-config-confirm-title" className="text-base font-semibold">{action.enabled ? "Включить MCP-сервер?" : "Отключить MCP-сервер?"}</h3><p className="mt-2 break-words text-sm leading-relaxed text-muted"><span className="font-medium text-text">{selectedServer?.name}</span> · {selectedServer?.scope === "workspace" ? "только для этого проекта" : "во всех проектах"}</p><p className="mt-2 text-xs leading-relaxed text-muted">Сохранится новая настройка Codex. Она начнёт действовать после отдельного перезапуска общего Codex runtime.</p></div>}
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => setAction(undefined)}>Отмена</Button><Button type="button" className="flex-1" disabled={saving || !canChange} onClick={() => void confirmAction()}>{saving ? "Выполняю…" : "Подтвердить"}</Button></div>
      </section>
    </div>}
  </>;
}
