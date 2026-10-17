import { useEffect, useState } from "react";
import { Activity, Bot, ChevronDown, CircleHelp, Clock3, Pause, Play, Plug, ShieldCheck, Sparkles, Target, Trash2, X } from "lucide-react";
import { readCapabilities } from "../api.js";
import type { MobileCapabilities, MobileOperation } from "../types.js";
import { Badge, Button, Card, Input, Textarea } from "./ui/primitives.js";

const effortLabel: Record<string, string> = {
  minimal: "Минимум", low: "Низкий", medium: "Средний", high: "Высокий", max: "Максимум",
};

export function SettingsPanel({ sessionId, connected, onClose, onOperation }: {
  sessionId: string;
  connected: boolean;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [capabilities, setCapabilities] = useState<MobileCapabilities>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [goalObjective, setGoalObjective] = useState("");
  const [goalBudget, setGoalBudget] = useState("");

  async function reload() {
    setLoading(true);
    try {
      const next = await readCapabilities(sessionId);
      setCapabilities(next);
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

  const inputClass = "min-h-11 w-full appearance-none rounded-xl border border-border bg-[#111613] px-3 pr-9 text-sm text-text outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50";
  const usable = Boolean(capabilities?.online && connected && !saving);

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="mobile-settings-title" className="safe-area-top safe-area-bottom flex h-full max-h-[100svh] w-full max-w-xl flex-col border-l border-border bg-background shadow-soft">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-4 sm:px-6">
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#a7c278]">Codex</p><h2 id="mobile-settings-title" className="mt-1 text-lg font-semibold">Настройки и возможности</h2></div>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть настройки" onClick={onClose}><X size={19} /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
        {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]">{error}</p>}
        {loading && !capabilities ? <p className="text-sm text-muted">Читаю данные текущего Codex…</p> : null}
        {capabilities && <>
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
          <Card className="space-y-3 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><Plug size={16} className="text-accent" /> MCP-серверы</h3>{capabilities.mcpServers.length ? <ul className="space-y-2">{capabilities.mcpServers.map((server) => <li key={server.name} className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{server.name}</span><Badge>{server.toolCount} инструментов</Badge></li>)}</ul> : <p className="text-xs text-muted">Подключённых MCP-серверов нет или их список недоступен.</p>}</Card>
          <Card className="space-y-3 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><Bot size={16} className="text-accent" /> Навыки и агенты</h3>{capabilities.skills.length ? <ul className="space-y-3">{capabilities.skills.map((skill) => <li key={skill.name}><p className="text-sm font-medium">{skill.name}</p>{skill.description && <p className="mt-1 text-xs leading-relaxed text-muted">{skill.description}</p>}</li>)}</ul> : <p className="text-xs text-muted">Навыки не найдены.</p>}{capabilities.subagents.length > 0 && <div className="border-t border-border pt-3"><p className="mb-2 text-xs font-semibold text-muted">Подагенты текущего владельца</p><ul className="space-y-2">{capabilities.subagents.map((agent) => <li key={agent.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{agent.name}</span><Badge>{agent.status}</Badge></li>)}</ul></div>}</Card>
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted"><CircleHelp size={14} className="mt-0.5 shrink-0" />Список строится из текущего локального runtime. Здесь отображаются только сведения для выбранного владельца, без локальных путей и секретов MCP.</p>
          <p className="text-center text-[10px] text-muted">Обновлено: {new Date(capabilities.checkedAt).toLocaleTimeString()}</p>
        </>}
      </div>
    </section>
  </div>;
}
