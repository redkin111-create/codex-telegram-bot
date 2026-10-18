import { useEffect, useState } from "react";
import { FolderPlus, GitBranch, GitCommit, Plus, RefreshCw, X } from "lucide-react";
import { readGitDiff, readGitStatus } from "../api.js";
import type { MobileGitDiff, MobileGitStatus, MobileOperation } from "../types.js";
import { Badge, Button, Card, Input } from "./ui/primitives.js";

export function GitPanel({ sessionId, connected, onClose, onOperation, onWorktreeCreated }: {
  sessionId: string;
  connected: boolean;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
  onWorktreeCreated: (sessionId: string, path: string) => void | Promise<void>;
}) {
  const [status, setStatus] = useState<MobileGitStatus>();
  const [diff, setDiff] = useState<MobileGitDiff>();
  const [diffScope, setDiffScope] = useState<{ path: string; previousPath?: string }>();
  const [view, setView] = useState<"unstaged" | "staged">("unstaged");
  const [loading, setLoading] = useState(true);
  const [loadingDiffPath, setLoadingDiffPath] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchTarget, setBranchTarget] = useState("");
  const [remoteBranchTarget, setRemoteBranchTarget] = useState("");
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [nextStatus, nextDiff] = await Promise.all([readGitStatus(sessionId), readGitDiff(sessionId, diffScope?.path, diffScope?.previousPath)]);
      setStatus(nextStatus);
      setBranchTarget((current) => nextStatus.branches.includes(current) ? current : nextStatus.branch);
      setRemoteBranchTarget((current) => nextStatus.remoteBranches.includes(current) ? current : nextStatus.remoteBranches[0] ?? "");
      setDiff(nextDiff);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать Git"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [sessionId]);

  async function loadDiff(path?: string, previousPath?: string) {
    setLoadingDiffPath(path ?? "*");
    setError("");
    try {
      const nextDiff = await readGitDiff(sessionId, path, previousPath);
      setDiff(nextDiff);
      setDiffScope(path ? { path, previousPath } : undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать diff"); }
    finally { setLoadingDiffPath(""); }
  }

  async function mutate(op: MobileOperation, args: Record<string, unknown>, message: string): Promise<unknown | undefined> {
    if (!connected || busyAction) return undefined;
    setBusyAction(op);
    setError("");
    setSuccess("");
    try {
      const result = await onOperation(op, { sessionId, ...args });
      if ((op === "gitCreateBranch" || op === "gitSwitchBranch" || op === "gitTrackRemoteBranch") && typeof result === "object" && result !== null && "branch" in result && typeof result.branch === "string") setBranchTarget(result.branch);
      setSuccess(message);
      if (op === "gitCommit") setCommitMessage("");
      if (op === "gitCreateBranch") setBranchName("");
      await refresh();
      return result;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Git не выполнил действие"); }
    finally { setBusyAction(""); }
  }

  async function createWorktree() {
    const branch = worktreeBranchName.trim();
    if (!branch || busyAction) return;
    const result = await mutate("createWorktree", { branchName: branch }, "Отдельная рабочая копия создана") as { sessionId?: unknown; path?: unknown } | undefined;
    if (typeof result?.sessionId !== "string" || typeof result.path !== "string") return;
    try {
      await onWorktreeCreated(result.sessionId, result.path);
      setWorktreeDialogOpen(false);
      setWorktreeBranchName("");
    } catch (cause) {
      setSuccess("");
      setError(`Рабочая папка создана, но сеанс не удалось подключить: ${cause instanceof Error ? cause.message : "ошибка Codex"}`);
    }
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
                <Button variant="ghost" className="min-h-9 px-2 text-[11px]" disabled={Boolean(loadingDiffPath)} aria-label={`Показать diff ${displayPath}`} onClick={() => void loadDiff(change.path, change.previousPath)}>{loadingDiffPath === change.path ? "Читаю" : "Diff"}</Button>
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
          {status.remoteBranches.length > 0 && <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); void mutate("gitTrackRemoteBranch", { remoteBranch: remoteBranchTarget }, "Удалённая ветка подключена"); }}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select aria-label="Удалённая ветка" className="min-h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={remoteBranchTarget} onChange={(event) => setRemoteBranchTarget(event.target.value)}>
                {status.remoteBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
              <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={!connected || !remoteBranchTarget || Boolean(busyAction)}><GitBranch size={16} />{busyAction === "gitTrackRemoteBranch" ? "Подключаю" : "Создать локальную ветку"}</Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted">Показаны уже загруженные на ноутбук ссылки. Телефон не выполняет fetch и не отправляет коммиты.</p>
          </form>}
          <div className="mt-5 flex flex-wrap gap-2">{diffScope && <Button variant="ghost" className="min-h-10 px-3" onClick={() => void loadDiff()}>Все файлы</Button>}<Button variant={view === "unstaged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("unstaged")}>Рабочая папка</Button><Button variant={view === "staged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("staged")}>Индекс</Button></div>
          <p className="mt-2 break-all text-[11px] text-muted">{diffScope ? `Diff: ${diffScope.previousPath ? `${diffScope.previousPath} → ` : ""}${diffScope.path}` : "Diff всех файлов"}</p>
          <Card className="mt-2 min-h-48 overflow-auto"><pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[#dce3da] sm:p-4">{loadingDiffPath ? "Читаю diff…" : patch || (status.clean ? "Нет незакоммиченных изменений." : "Git не создал текстовый diff для этих изменений.")}</pre></Card>
          <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void mutate("gitCommit", { message: commitMessage }, "Изменения сохранены коммитом"); }}>
            <Input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Сообщение коммита" aria-label="Сообщение коммита" maxLength={200} />
            <Button type="submit" className="min-h-10 shrink-0" disabled={!connected || stagedCount === 0 || !commitMessage.trim() || Boolean(busyAction)}><GitCommit size={16} />{busyAction === "gitCommit" ? "Сохраняю" : `Коммит (${stagedCount})`}</Button>
          </form>
          <form className="mt-3 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void mutate("gitCreateBranch", { name: branchName }, "Ветка создана и выбрана"); }}>
            <Input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="Имя новой ветки" aria-label="Имя новой ветки" maxLength={120} />
            <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={!connected || !branchName.trim() || Boolean(busyAction)}><Plus size={16} />{busyAction === "gitCreateBranch" ? "Создаю" : "Новая ветка"}</Button>
          </form>
          <Card className="mt-4 space-y-3 p-4">
            <div><h3 className="flex items-center gap-2 text-sm font-semibold"><FolderPlus size={16} className="text-accent" /> Отдельная рабочая копия</h3><p className="mt-2 text-xs leading-relaxed text-muted">Создаст отдельную папку, ветку и новый сеанс Codex на текущем коммите. Незакоммиченные файлы в неё не попадут.</p></div>
            <Button type="button" variant="outline" className="w-full" disabled={!connected || Boolean(busyAction)} onClick={() => setWorktreeDialogOpen(true)}><FolderPlus size={15} /> Создать worktree</Button>
          </Card>
          {!connected && <p className="mt-3 text-xs text-muted">Подключите сеанс, чтобы менять индекс, создавать ветки и коммиты.</p>}
          <p className="mt-3 text-[11px] leading-relaxed text-muted">Команды ограничены текущим проектом. Внешние diff-программы и textconv-фильтры выключены.</p>
        </>}
      </div>
    </section>
    {worktreeDialogOpen && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="worktree-confirm-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div><h3 id="worktree-confirm-title" className="text-base font-semibold">Создать отдельную рабочую копию?</h3><p className="mt-2 text-xs leading-relaxed text-muted">Codex создаст ветку от текущего коммита и откроет новый сеанс в отдельной папке. Незакоммиченные изменения останутся в исходном сеансе.</p></div>
        <label className="block space-y-1.5"><span className="text-xs text-muted">Имя новой ветки</span><Input aria-label="Имя ветки рабочей копии" value={worktreeBranchName} onChange={(event) => setWorktreeBranchName(event.target.value)} maxLength={80} placeholder="например mobile/experiment" disabled={Boolean(busyAction)} /></label>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={Boolean(busyAction)} onClick={() => setWorktreeDialogOpen(false)}>Отмена</Button><Button type="button" className="flex-1" disabled={!connected || !worktreeBranchName.trim() || Boolean(busyAction)} onClick={() => void createWorktree()}>{busyAction === "createWorktree" ? "Создаю…" : "Создать"}</Button></div>
      </section>
    </div>}
  </div>;
}
