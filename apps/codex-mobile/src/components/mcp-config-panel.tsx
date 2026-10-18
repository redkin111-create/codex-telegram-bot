import { useEffect, useState } from "react";
import { Plug, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import type { MobileOperation } from "../types.js";
import { Badge, Button, Card } from "./ui/primitives.js";

type McpConfigEntry = { name: string; scope: "global" | "workspace"; enabled: boolean; transport: "http" | "stdio" | "unknown" };
type McpConfigAction = { name: string; enabled: boolean } | { restart: true };

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

  useEffect(() => { void reload(); }, [sessionId]);

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

  const selectedServer = action && !("restart" in action) ? servers.find((server) => server.name === action.name) : undefined;

  return <>
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug size={16} className="text-accent" /> Настройки MCP</h3>
        <Button type="button" variant="ghost" aria-label="Обновить настройки MCP" className="min-h-9 px-2" disabled={loading || saving} onClick={() => void reload()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></Button>
      </div>
      {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-xs leading-relaxed text-[#ffc3bd]">{error}</p>}
      {loading && servers.length === 0 ? <p className="text-xs text-muted">Читаю локальные настройки…</p>
        : servers.length ? <ul className="space-y-2">{servers.map((server) => <li key={`${server.scope}:${server.name}`} className="rounded-xl border border-border bg-[#111613] p-3">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{server.name}</p><p className="mt-1 text-[11px] text-muted">{server.scope === "workspace" ? "Проект" : "Все проекты"} · {server.transport === "stdio" ? "локальный процесс" : server.transport === "http" ? "HTTP" : "тип неизвестен"}</p></div><Badge className={server.enabled ? "border-[#3d5630] text-[#c7e89a]" : "border-[#733b39] text-[#ffc3bd]"}>{server.enabled ? "Включён" : "Отключён"}</Badge></div>
          <div className="mt-3 flex justify-end"><Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label={`${server.enabled ? "Отключить" : "Включить"} MCP ${server.name}`} disabled={!canChange || saving} onClick={() => setAction({ name: server.name, enabled: !server.enabled })}>{server.enabled ? "Отключить" : "Включить"}</Button></div>
        </li>)}</ul> : <p className="text-xs text-muted">Настроенных MCP-серверов нет.</p>}
      {restartRequired && <div className="space-y-2 rounded-xl border border-[#705d31] bg-[#2a2517] p-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-[#eadcae]"><ShieldAlert size={15} className="mt-0.5 shrink-0" />Настройка сохранена. Чтобы применить её, перезапустится общий Codex runtime и подключённые сеансы переподключатся.</p>
        <Button type="button" variant="outline" className="min-h-10 w-full text-xs" disabled={!canChange || saving} onClick={() => setAction({ restart: true })}><RotateCcw size={14} /> Применить с перезапуском Codex</Button>
      </div>}
      <p className="text-[11px] leading-relaxed text-muted">Показываются только имена, область и тип. Команды, адреса, параметры и секреты не передаются в браузер. Изменение настроек влияет на Codex на этом компьютере.</p>
      {!canChange && <p className="text-[11px] text-muted">Чтобы изменить настройки, подключите Codex к сети.</p>}
    </Card>
    {action && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="mcp-config-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        {"restart" in action ? <div><h3 id="mcp-config-confirm-title" className="text-base font-semibold">Перезапустить Codex?</h3><p className="mt-2 text-sm leading-relaxed text-muted">Перезапустится общий Codex runtime на компьютере. Все подключённые сеансы переподключатся. Дождитесь завершения активных задач и очистите очередь перед подтверждением.</p></div>
          : <div><h3 id="mcp-config-confirm-title" className="text-base font-semibold">{action.enabled ? "Включить MCP-сервер?" : "Отключить MCP-сервер?"}</h3><p className="mt-2 break-words text-sm leading-relaxed text-muted"><span className="font-medium text-text">{selectedServer?.name}</span> · {selectedServer?.scope === "workspace" ? "только для этого проекта" : "во всех проектах"}</p><p className="mt-2 text-xs leading-relaxed text-muted">Сохранится новая настройка Codex. Она начнёт действовать после отдельного перезапуска общего Codex runtime.</p></div>}
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={saving} onClick={() => setAction(undefined)}>Отмена</Button><Button type="button" className="flex-1" disabled={saving || !canChange} onClick={() => void confirmAction()}>{saving ? "Выполняю…" : "Подтвердить"}</Button></div>
      </section>
    </div>}
  </>;
}
