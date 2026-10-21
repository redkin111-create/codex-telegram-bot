import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, ShieldAlert, Terminal as TerminalIcon, X } from "lucide-react";
import type { MobileBackgroundTerminal, MobileOperation } from "../types.js";
import { Button, Card, Textarea } from "./ui/primitives.js";

interface TerminalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

type TerminalShellId = "cmd" | "powershell" | "default";
interface TerminalShellOption { id: TerminalShellId; label: string; }
interface TerminalShellsResult { shells: TerminalShellOption[]; }
interface TerminalStartResult { terminalId: string; shell: string; shellId: TerminalShellId; reused: boolean; exited: boolean; }
interface TerminalReadResult { terminalId: string; output: string; nextOffset: number; truncated: boolean; exited: boolean; exitCode: number | null; }

function isTerminalShellId(value: unknown): value is TerminalShellId {
  return value === "cmd" || value === "powershell" || value === "default";
}

export function TerminalPanel({ sessionId, cwd, connected, onClose, onOperation }: {
  sessionId: string;
  cwd: string;
  connected: boolean;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<"interactive" | "command">("interactive");
  return <>
    <div className="fixed inset-0 z-40 bg-black/70" role="presentation" onClick={onClose} />
    <section role="dialog" aria-modal="true" aria-labelledby="terminal-title" className="safe-area-top safe-area-bottom fixed inset-x-0 bottom-0 z-50 flex max-h-[96dvh] flex-col rounded-t-2xl border border-border bg-[#141815] shadow-soft md:inset-y-0 md:right-0 md:left-auto md:w-[min(720px,100vw)] md:rounded-none">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#a7c278]">CODEX-MOBILE</p><h2 id="terminal-title" className="mt-1 flex items-center gap-2 text-base font-semibold"><TerminalIcon size={17} /> Терминал проекта</h2></div>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть терминал" onClick={onClose}><X size={18} /></Button>
      </header>
      <div className="flex shrink-0 gap-2 border-b border-border px-4 py-2" role="tablist" aria-label="Режим терминала">
        <button role="tab" aria-selected={mode === "interactive"} className={`min-h-10 flex-1 rounded-lg px-3 text-sm ${mode === "interactive" ? "bg-elevated text-text" : "text-muted"}`} onClick={() => setMode("interactive")}>Интерактивный</button>
        <button role="tab" aria-selected={mode === "command"} className={`min-h-10 flex-1 rounded-lg px-3 text-sm ${mode === "command" ? "bg-elevated text-text" : "text-muted"}`} onClick={() => setMode("command")}>Одна команда</button>
      </div>
      <div className={mode === "interactive" ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4" : "hidden"}>
        <Card className="shrink-0 space-y-2 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Рабочая папка</p>
          <p className="break-all font-mono text-xs text-text">{cwd}</p>
          <p className="text-xs leading-relaxed text-muted">Команды выполняются на компьютере от имени текущего пользователя. Терминал может запускать программы и менять файлы проекта.</p>
        </Card>
        <BackgroundProcessPanel sessionId={sessionId} connected={connected} onOperation={onOperation} />
        <InteractiveTerminal sessionId={sessionId} connected={connected} onOperation={onOperation} />
      </div>
      <div className={mode === "command" ? "min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" : "hidden"}>
        <OneShotTerminal sessionId={sessionId} cwd={cwd} connected={connected} onOperation={onOperation} />
      </div>
    </section>
  </>;
}

function BackgroundProcessPanel({ sessionId, connected, onOperation }: {
  sessionId: string;
  connected: boolean;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [items, setItems] = useState<MobileBackgroundTerminal[]>();
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pending, setPending] = useState<MobileBackgroundTerminal>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestVersion = useRef(0);

  async function refresh() {
    if (!connected) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const result = await onOperation("listBackgroundTerminals", { sessionId }) as { items?: unknown };
      if (!Array.isArray(result?.items)) throw new Error("Codex вернул неверный список фоновых процессов");
      if (version !== requestVersion.current) return;
      setItems(result.items.filter((item): item is MobileBackgroundTerminal => Boolean(item) &&
        typeof item === "object" && typeof (item as MobileBackgroundTerminal).itemId === "string" &&
        typeof (item as MobileBackgroundTerminal).processId === "string"));
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setItems(undefined);
      setError(cause instanceof Error ? cause.message : "Не удалось получить список фоновых процессов");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    requestVersion.current += 1;
    setItems(undefined);
    setLoading(false);
    setError("");
    setNotice("");
    if (connected) void refresh();
    return () => { requestVersion.current += 1; };
    // The session and connection state identify when the native list must be reloaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connected]);

  async function stop() {
    if (!pending || stopping) return;
    setStopping(true);
    setError("");
    setNotice("");
    try {
      await onOperation("stopBackgroundTerminal", { sessionId, processId: pending.processId });
      setPending(undefined);
      setNotice(`Фоновый процесс ${pending.processId} остановлен`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось остановить фоновый процесс");
    } finally { setStopping(false); }
  }

  return <>
    <Card className="shrink-0 space-y-3 p-3" aria-label="Фоновые процессы Codex">
      <div className="flex items-center justify-between gap-2">
        <div><h3 className="text-sm font-semibold">Фоновые процессы Codex</h3><p className="mt-1 text-[11px] text-muted">Показывает идентификаторы фоновых процессов в этом сеансе.</p></div>
        <Button type="button" variant="outline" className="min-h-9 shrink-0 px-3 text-xs" disabled={!connected || loading} onClick={() => void refresh()}>{loading ? <LoaderCircle size={14} className="animate-spin" /> : null}Обновить</Button>
      </div>
      {!connected ? <p className="text-xs text-muted">Подключите сеанс Codex, чтобы проверить фоновые процессы.</p>
        : loading && items === undefined ? <p role="status" className="text-xs text-muted">Загружаю список…</p>
          : error && items === undefined ? <p role="alert" className="text-xs text-[#ffc3bd]">{error}</p>
            : items?.length ? <ul className="space-y-2">{items.map((item) => <li key={item.processId} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-[#111613] p-3">
              <div className="min-w-0"><p className="text-xs font-medium">Процесс Codex</p><p className="mt-1 break-all font-mono text-[11px] text-muted">ID: {item.processId}</p></div>
              <Button type="button" variant="danger" className="min-h-9 shrink-0 px-3 text-xs" disabled={stopping || loading} aria-label={`Остановить процесс ${item.processId}`} onClick={() => setPending(item)}>Остановить</Button>
            </li>)}</ul>
              : <p role="status" className="text-xs text-muted">Фоновых процессов нет.</p>}
      {error && items !== undefined && <p role="alert" className="text-xs text-[#ffc3bd]">{error}</p>}
      {notice && <p role="status" className="text-xs text-accent">{notice}</p>}
    </Card>
    {pending && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="background-process-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-[#733b39] bg-elevated p-5 shadow-soft">
        <div><h3 id="background-process-confirm-title" className="flex items-center gap-2 text-base font-semibold"><ShieldAlert size={17} className="text-[#f2c66d]" />Остановить процесс Codex?</h3><p className="mt-2 text-sm leading-relaxed text-muted">Codex завершит выбранную фоновую команду в этом сеансе. Другие процессы и сеансы не затрагиваются.</p></div>
        <p className="break-all rounded-lg bg-[#0c100d] p-3 font-mono text-xs text-text">ID процесса: {pending.processId}</p>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={stopping} onClick={() => setPending(undefined)}>Отмена</Button><Button type="button" variant="danger" className="flex-1" disabled={!connected || stopping} onClick={() => void stop()}>{stopping ? <LoaderCircle size={15} className="animate-spin" /> : null}Остановить</Button></div>
      </section>
    </div>}
  </>;
}

function InteractiveTerminal({ sessionId, connected, onOperation }: {
  sessionId: string;
  connected: boolean;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XtermTerminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef("");
  const offset = useRef(0);
  const inputBuffer = useRef("");
  const inputTimer = useRef<number | undefined>(undefined);
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());
  const operationRef = useRef(onOperation);
  const flushRef = useRef<() => void>(() => {});
  const [terminalId, setTerminalId] = useState("");
  const [shells, setShells] = useState<TerminalShellOption[]>([]);
  const [selectedShell, setSelectedShell] = useState<TerminalShellId | "">("");
  const [activeShell, setActiveShell] = useState("");
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState("");

  operationRef.current = onOperation;

  useEffect(() => {
    let active = true;
    setShells([]);
    setActiveShell("");
    if (!connected) {
      setSelectedShell("");
      return () => { active = false; };
    }
    void operationRef.current("listTerminalShells", { sessionId }).then((result: unknown) => {
      const options = (result as TerminalShellsResult | undefined)?.shells;
      if (!Array.isArray(options) || options.some((option) => !option || !isTerminalShellId(option.id) || typeof option.label !== "string")) {
        throw new Error("Codex вернул неверный список оболочек терминала");
      }
      if (!active) return;
      setShells(options);
      setSelectedShell((current) => options.some((option) => option.id === current) ? current : options[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Не удалось получить список оболочек");
    });
    return () => { active = false; };
  }, [sessionId, connected]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const instance = new XtermTerminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      scrollback: 5000,
      convertEol: false,
      theme: { background: "#0c100d", foreground: "#dce3da", cursor: "#a7c278", selectionBackground: "#394638" },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(parent);
    instance.writeln("Откройте интерактивный терминал после проверки предупреждения.");
    terminal.current = instance;
    fit.current = fitAddon;
    const data = instance.onData((value) => {
      if (!terminalIdRef.current) return;
      inputBuffer.current += value;
      if (inputTimer.current !== undefined) return;
      inputTimer.current = window.setTimeout(() => flushRef.current(), 35);
    });
    const resize = instance.onResize(({ cols, rows }) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void operationRef.current("terminalResize", { sessionId, terminalId: id, cols, rows }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Не удалось изменить размер терминала");
      });
    });
    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* The panel may be hidden while changing modes. */ }
    });
    observer.observe(parent);
    try { fitAddon.fit(); } catch { /* The first layout can have no measured size. */ }
    flushRef.current = () => {
      if (inputTimer.current !== undefined) window.clearTimeout(inputTimer.current);
      inputTimer.current = undefined;
      const value = inputBuffer.current;
      const id = terminalIdRef.current;
      if (!value || !id) return;
      inputBuffer.current = "";
      inputQueue.current = inputQueue.current.then(() => operationRef.current("terminalInput", { sessionId, terminalId: id, data: value })).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Не удалось отправить ввод в терминал");
      });
    };
    return () => {
      observer.disconnect();
      data.dispose();
      resize.dispose();
      if (inputTimer.current !== undefined) window.clearTimeout(inputTimer.current);
      flushRef.current();
      instance.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!terminalId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await operationRef.current("terminalRead", { sessionId, terminalId, offset: offset.current }) as TerminalReadResult;
        if (!active) return;
        if (next.truncated) terminal.current?.writeln("\r\n[Часть старого вывода уже удалена из ограниченного буфера]");
        if (next.output) terminal.current?.write(next.output);
        offset.current = next.nextOffset;
        if (next.exited) {
          setExited(true);
          terminal.current?.writeln(`\r\n[Терминал завершён · код ${next.exitCode === null ? "неизвестен" : next.exitCode}]`);
          return;
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Соединение с терминалом потеряно");
      }
      if (active) timer = window.setTimeout(() => void poll(), 650);
    };
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [sessionId, terminalId]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !terminalId || exited;
  }, [exited, terminalId]);

  async function start() {
    if (!connected || starting) return;
    if (!selectedShell || !shells.some((option) => option.id === selectedShell)) {
      setError("Выберите доступную оболочку терминала");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const result = await operationRef.current("terminalStart", { sessionId, shell: selectedShell }) as TerminalStartResult;
      if (!result.terminalId || !isTerminalShellId(result.shellId)) throw new Error("Codex не вернул подключение к выбранной оболочке");
      const actualShell = shells.find((option) => option.id === result.shellId);
      if (!actualShell) throw new Error("Codex подключил недоступную оболочку терминала");
      if (terminalIdRef.current || exited) terminal.current?.reset();
      terminal.current?.writeln(result.reused ? "\r\n[Подключение к существующему терминалу восстановлено]" : "\r\n[Терминал подключён]");
      terminalIdRef.current = result.terminalId;
      setTerminalId(result.terminalId);
      setSelectedShell(result.shellId);
      setActiveShell(actualShell.label);
      setExited(result.exited);
      offset.current = 0;
      fit.current?.fit();
      const cols = terminal.current?.cols ?? 80;
      const rows = terminal.current?.rows ?? 24;
      await operationRef.current("terminalResize", { sessionId, terminalId: result.terminalId, cols, rows });
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть терминал");
    } finally { setStarting(false); }
  }

  async function stop() {
    const id = terminalIdRef.current;
    if (!id) return;
    flushRef.current();
    try {
      await operationRef.current("terminalStop", { sessionId, terminalId: id });
      setExited(true);
      if (terminal.current) terminal.current.options.disableStdin = true;
      terminal.current?.writeln("\r\n[Терминал остановлен]");
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось остановить терминал"); }
  }

  return <>
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <p role="status" className="text-xs text-muted">{!connected ? "Подключите сеанс Codex" : terminalId ? exited ? "Терминал завершён" : "Интерактивный терминал подключён" : "Терминал не запущен"}</p>
          {activeShell && <p className="text-xs text-accent">Оболочка: {activeShell}</p>}
        </div>
        <div className="flex gap-2">
          {!terminalId || exited ? <Button type="button" className="min-h-10 px-3" disabled={!connected || starting} onClick={() => setConfirming(true)}>{starting ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}{exited ? "Новый терминал" : "Запустить терминал"}</Button>
            : <Button type="button" variant="outline" className="min-h-10 px-3" onClick={() => void stop()}>Остановить</Button>}
        </div>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
        Оболочка
        <select aria-label="Оболочка" value={selectedShell} disabled={!connected || starting || Boolean(terminalId && !exited) || !shells.length}
          onChange={(event) => setSelectedShell(isTerminalShellId(event.currentTarget.value) ? event.currentTarget.value : "")}
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-border bg-elevated px-3 text-sm text-text disabled:opacity-60">
          {!shells.length && <option value="">Загрузка…</option>}
          {shells.map((shell) => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
        </select>
      </label>
      {!connected && <p className="text-xs text-muted">Сначала подключите этот сеанс, чтобы управлять его терминалом.</p>}
      {error && <p role="alert" className="shrink-0 rounded-xl border border-[#733b39] bg-[#351f1e] p-2 text-xs text-[#ffc3bd]">{error}</p>}
      <div ref={host} role="application" aria-label="Интерактивный терминал проекта" className="min-h-56 flex-1 overflow-hidden rounded-xl border border-border bg-[#0c100d] p-2" />
    </div>
    {confirming && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="pty-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div><h3 id="pty-confirm-title" className="flex items-center gap-2 text-base font-semibold"><ShieldAlert size={17} className="text-[#f2c66d]" />Открыть интерактивную оболочку?</h3><p className="mt-2 text-sm leading-relaxed text-muted">Команды выполняются на компьютере с правами вашей учётной записи Windows. Они могут запускать программы, менять файлы и обращаться к сети.</p></div>
        <p className="break-all rounded-lg bg-[#0c100d] p-3 font-mono text-xs text-text">Сеанс Codex: {sessionId}</p>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={starting} onClick={() => setConfirming(false)}>Отмена</Button><Button type="button" className="flex-1" disabled={!connected || starting} onClick={() => void start()}>{starting ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}Открыть терминал</Button></div>
      </section>
    </div>}
  </>;
}

function OneShotTerminal({ sessionId, cwd, connected, onOperation }: {
  sessionId: string;
  cwd: string;
  connected: boolean;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [command, setCommand] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TerminalResult>();
  const [error, setError] = useState("");

  async function execute() {
    if (!connected || !command.trim() || running) return;
    setRunning(true);
    setError("");
    setResult(undefined);
    try {
      const next = await onOperation("terminalExec", { sessionId, command: command.trim() }) as TerminalResult;
      setResult(next);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить команду");
    } finally { setRunning(false); }
  }

  const output = [result?.stdout, result?.stderr].filter(Boolean).join(result?.stdout && result?.stderr ? "\n" : "");
  return <div className="space-y-4">
    <Card className="space-y-2 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Рабочая папка</p>
      <p className="break-all font-mono text-xs text-text">{cwd}</p>
      <p className="text-xs leading-relaxed text-muted">Выполняется только одна команда с лимитом 60 секунд. Перед запуском подтвердите её текст.</p>
    </Card>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); setConfirming(true); }}>
      <label className="block space-y-1.5"><span className="text-xs font-semibold text-muted">Команда терминала</span><Textarea aria-label="Команда терминала" value={command} onChange={(event) => setCommand(event.target.value)} maxLength={4000} placeholder="Например: git status" disabled={!connected || running} className="min-h-28 font-mono text-xs" /></label>
      {!connected && <p className="text-xs text-muted">Сначала подключите сеанс Codex, чтобы запускать команды в его папке.</p>}
      <Button type="submit" className="w-full" disabled={!connected || !command.trim() || running}><Play size={15} /> Проверить и запустить</Button>
    </form>
    {error && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]">{error}</p>}
    {result && <Card className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><strong>Код выхода: {result.exitCode === null ? "не получен" : result.exitCode}</strong><span className="text-muted">{result.timedOut ? "Превышен лимит 60 секунд" : `${result.durationMs} мс`}</span></div>
      {result.truncated && <p className="text-xs text-muted">Вывод сокращён до безопасного размера.</p>}
      {output ? <pre className="max-h-[40dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0c100d] p-3 font-mono text-xs leading-relaxed text-text">{output}</pre> : <p className="text-xs text-muted">Команда ничего не вывела.</p>}
    </Card>}
    {confirming && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="terminal-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div><h3 id="terminal-confirm-title" className="flex items-center gap-2 text-base font-semibold"><ShieldAlert size={17} className="text-[#f2c66d]" />Запустить эту команду?</h3><p className="mt-2 text-xs leading-relaxed text-muted">Команда выполнится в рабочей папке проекта с правами текущего пользователя Windows.</p></div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0c100d] p-3 font-mono text-xs leading-relaxed text-text">{command.trim()}</pre>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={running} onClick={() => setConfirming(false)}>Отмена</Button><Button type="button" className="flex-1" disabled={!connected || running} onClick={() => void execute()}>{running ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}Запустить</Button></div>
      </section>
    </div>}
  </div>;
}
