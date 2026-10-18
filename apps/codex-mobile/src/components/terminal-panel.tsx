import { useState } from "react";
import { LoaderCircle, Play, ShieldAlert, Terminal, X } from "lucide-react";
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

export function TerminalPanel({ sessionId, cwd, connected, onClose, onOperation }: {
  sessionId: string;
  cwd: string;
  connected: boolean;
  onClose: () => void;
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

  return <>
    <div className="fixed inset-0 z-40 bg-black/70" role="presentation" onClick={onClose} />
    <section role="dialog" aria-modal="true" aria-labelledby="terminal-title" className="safe-area-bottom fixed inset-x-0 bottom-0 z-50 flex max-h-[92svh] flex-col rounded-t-2xl border border-border bg-[#141815] shadow-soft md:inset-y-0 md:right-0 md:left-auto md:w-[min(640px,100vw)] md:rounded-none">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#a7c278]">CODEX-MOBILE</p><h2 id="terminal-title" className="mt-1 flex items-center gap-2 text-base font-semibold"><Terminal size={17} /> Терминал проекта</h2></div>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть терминал" onClick={onClose}><X size={18} /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Card className="space-y-2 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Рабочая папка</p>
          <p className="break-all font-mono text-xs text-text">{cwd}</p>
          <p className="text-xs leading-relaxed text-muted">Команды запускаются на компьютере с Codex. Перед каждым запуском нужно подтвердить точный текст команды.</p>
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
      </div>
    </section>
    {confirming && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="terminal-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div><h3 id="terminal-confirm-title" className="flex items-center gap-2 text-base font-semibold"><ShieldAlert size={17} className="text-[#f2c66d]" />Запустить эту команду?</h3><p className="mt-2 text-xs leading-relaxed text-muted">Команда выполнится в рабочей папке проекта с правами текущего пользователя Windows.</p></div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[#0c100d] p-3 font-mono text-xs leading-relaxed text-text">{command.trim()}</pre>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={running} onClick={() => setConfirming(false)}>Отмена</Button><Button type="button" className="flex-1" disabled={!connected || running} onClick={() => void execute()}>{running ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}Запустить</Button></div>
      </section>
    </div>}
  </>;
}
