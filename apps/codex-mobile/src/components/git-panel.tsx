import { useEffect, useState } from "react";
import { GitBranch, GitCommit, Plus, RefreshCw, X } from "lucide-react";
import { readGitDiff, readGitStatus } from "../api.js";
import type { MobileGitDiff, MobileGitStatus, MobileOperation } from "../types.js";
import { Badge, Button, Card, Input } from "./ui/primitives.js";

export function GitPanel({ sessionId, connected, onClose, onOperation }: {
  sessionId: string;
  connected: boolean;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [status, setStatus] = useState<MobileGitStatus>();
  const [diff, setDiff] = useState<MobileGitDiff>();
  const [view, setView] = useState<"unstaged" | "staged">("unstaged");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchTarget, setBranchTarget] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [nextStatus, nextDiff] = await Promise.all([readGitStatus(sessionId), readGitDiff(sessionId)]);
      setStatus(nextStatus);
      setBranchTarget((current) => nextStatus.branches.includes(current) ? current : nextStatus.branch);
      setDiff(nextDiff);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать Git"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [sessionId]);

  async function mutate(op: MobileOperation, args: Record<string, unknown>, message: string) {
    if (!connected || busyAction) return;
    setBusyAction(op);
    setError("");
    setSuccess("");
    try {
      const result = await onOperation(op, { sessionId, ...args });
      if ((op === "gitCreateBranch" || op === "gitSwitchBranch") && typeof result === "object" && result !== null && "branch" in result && typeof result.branch === "string") setBranchTarget(result.branch);
      setSuccess(message);
      if (op === "gitCommit") setCommitMessage("");
      if (op === "gitCreateBranch") setBranchName("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Git не выполнил действие"); }
    finally { setBusyAction(""); }
  }

  const patch = view === "staged" ? diff?.staged ?? "" : diff?.unstaged ?? "";
  const stagedCount = status?.changes.filter((change) => change.indexStatus !== " " && change.indexStatus !== "?").length ?? 0;

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="git-title" className="safe-area-top safe-area-bottom flex h-full max-h-[100svh] w-full max-w-3xl flex-col border-l border-border bg-background shadow-soft">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
        <GitBranch size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#a7c278]">{status?.project ?? "Проект"}</p><h2 id="git-title" className="truncate text-base font-semibold">Git и изменения</h2></div>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Обновить Git" onClick={() => void refresh()} disabled={loading || Boolean(busyAction)}><RefreshCw size={17} className={loading ? "animate-spin" : ""} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть Git" onClick={onClose}><X size={18} /></Button>
      </header>
      {error && <p role="alert" className="m-4 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd] sm:mx-6">{error}</p>}
      {success && <p role="status" className="mx-4 mt-3 text-sm text-[#c7e89a] sm:mx-6">{success}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading && !status ? <p className="text-sm text-muted">Читаю статус Git…</p> : status && <>
          <Card className="p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-muted">Текущая ветка</p><p className="mt-1 break-all font-mono text-sm">{status.branch || "не определена"}</p></div><Badge className={status.clean ? "border-[#3d5630] text-[#c7e89a]" : "text-[#f2c66d]"}>{status.clean ? "Чисто" : `${status.changes.length} изменений`}</Badge></div>
            {status.changes.length > 0 && <ul className="mt-4 divide-y divide-border">{status.changes.map((change, index) => {
              const needsStage = change.code === "??" || (change.worktreeStatus !== " " && change.worktreeStatus !== "?");
              const needsUnstage = change.indexStatus !== " " && change.indexStatus !== "?";
              const displayPath = change.previousPath ? `${change.previousPath} → ${change.path}` : change.path;
              return <li key={`${change.code}-${change.path}-${index}`} className="flex flex-wrap items-center gap-2 py-2 font-mono text-xs">
                <span className="shrink-0 text-[#c7e89a]">{change.code}</span><span className="min-w-0 flex-1 break-all text-muted">{displayPath}</span>
                {needsStage && <Button variant="ghost" className="min-h-9 px-2 text-[11px]" disabled={!connected || Boolean(busyAction)} aria-label={`Добавить ${displayPath} в индекс`} onClick={() => void mutate("gitStage", { path: change.path }, "Файл добавлен в индекс")}>В индекс</Button>}
                {needsUnstage && <Button variant="ghost" className="min-h-9 px-2 text-[11px]" disabled={!connected || Boolean(busyAction)} aria-label={`Убрать ${displayPath} из индекса`} onClick={() => void mutate("gitUnstage", { path: change.path, previousPath: change.previousPath }, "Файл убран из индекса")}>Снять</Button>}
              </li>;
            })}</ul>}
          </Card>
          {status.branches.length > 0 && <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void mutate("gitSwitchBranch", { name: branchTarget }, "Ветка переключена"); }}>
            <select aria-label="Существующая ветка" className="min-h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={branchTarget} onChange={(event) => setBranchTarget(event.target.value)}>
              {status.branches.map((branch) => <option key={branch} value={branch}>{branch}{branch === status.branch ? " · текущая" : ""}</option>)}
            </select>
            <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={!connected || !branchTarget || branchTarget === status.branch || Boolean(busyAction)}><GitBranch size={16} />{busyAction === "gitSwitchBranch" ? "Переключаю" : "Переключить"}</Button>
          </form>}
          <div className="mt-5 flex gap-2"><Button variant={view === "unstaged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("unstaged")}>Рабочая папка</Button><Button variant={view === "staged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("staged")}>Индекс</Button></div>
          <Card className="mt-3 min-h-48 overflow-auto"><pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[#dce3da] sm:p-4">{patch || (status.clean ? "Нет незакоммиченных изменений." : "Git не создал текстовый diff для этих изменений.")}</pre></Card>
          <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void mutate("gitCommit", { message: commitMessage }, "Изменения сохранены коммитом"); }}>
            <Input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Сообщение коммита" aria-label="Сообщение коммита" maxLength={200} />
            <Button type="submit" className="min-h-10 shrink-0" disabled={!connected || stagedCount === 0 || !commitMessage.trim() || Boolean(busyAction)}><GitCommit size={16} />{busyAction === "gitCommit" ? "Сохраняю" : `Коммит (${stagedCount})`}</Button>
          </form>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void mutate("gitCreateBranch", { name: branchName }, "Ветка создана и выбрана"); }}>
            <Input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="Имя новой ветки" aria-label="Имя новой ветки" maxLength={120} />
            <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={!connected || !branchName.trim() || Boolean(busyAction)}><Plus size={16} />{busyAction === "gitCreateBranch" ? "Создаю" : "Новая ветка"}</Button>
          </form>
          {!connected && <p className="mt-3 text-xs text-muted">Подключите сеанс, чтобы менять индекс, создавать ветки и коммиты.</p>}
          <p className="mt-3 text-[11px] leading-relaxed text-muted">Команды ограничены текущим проектом. Внешние diff-программы и textconv-фильтры выключены.</p>
        </>}
      </div>
    </section>
  </div>;
}
