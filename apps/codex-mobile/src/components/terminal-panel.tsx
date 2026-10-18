import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { LoaderCircle, Play, ShieldAlert, Terminal as TerminalIcon, X } from "lucide-react";
import type { MobileOperation } from "../types.js";
import { Button, Card, Textarea } from "./ui/primitives.js";

interface TerminalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

interface TerminalStartResult { terminalId: string; shell: string; reused: boolean; exited: boolean; }
interface TerminalReadResult { terminalId: string; output: string; nextOffset: number; truncated: boolean; exited: boolean; exitCode: number | null; }

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
    <section role="dialog" aria-modal="true" aria-labelledby="terminal-title" className="safe-area-bottom fixed inset-x-0 bottom-0 z-50 flex max-h-[96svh] flex-col rounded-t-2xl border border-border bg-[#141815] shadow-soft md:inset-y-0 md:right-0 md:left-auto md:w-[min(720px,100vw)] md:rounded-none">
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
        <InteractiveTerminal sessionId={sessionId} connected={connected} onOperation={onOperation} />
      </div>
      <div className={mode === "command" ? "min-h-0 flex-1 overflow-y-auto p-3 sm:p-4" : "hidden"}>
        <OneShotTerminal sessionId={sessionId} cwd={cwd} connected={connected} onOperation={onOperation} />
      </div>
    </section>
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
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState("");

  operationRef.current = onOperation;

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
    setStarting(true);
    setError("");
    try {
      const result = await operationRef.current("terminalStart", { sessionId }) as TerminalStartResult;
      if (!result.terminalId) throw new Error("Codex не вернул подключение к терминалу");
      if (terminalIdRef.current || exited) terminal.current?.reset();
      terminal.current?.writeln(result.reused ? "\r\n[Подключение к существующему терминалу восстановлено]" : "\r\n[Терминал подключён]");
      terminalIdRef.current = result.terminalId;
      setTerminalId(result.terminalId);
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
        <p role="status" className="text-xs text-muted">{!connected ? "Подключите сеанс Codex" : terminalId ? exited ? "Терминал завершён" : "Интерактивный терминал подключён" : "Терминал не запущен"}</p>
        <div className="flex gap-2">
          {!terminalId || exited ? <Button type="button" className="min-h-10 px-3" disabled={!connected || starting} onClick={() => setConfirming(true)}>{starting ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}{exited ? "Новый терминал" : "Запустить терминал"}</Button>
            : <Button type="button" variant="outline" className="min-h-10 px-3" onClick={() => void stop()}>Остановить</Button>}
        </div>
      </div>
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
      {output ? <pre className="max-h-[40svh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0c100d] p-3 font-mono text-xs leading-relaxed text-text">{output}</pre> : <p className="text-xs text-muted">Команда ничего не вывела.</p>}
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
