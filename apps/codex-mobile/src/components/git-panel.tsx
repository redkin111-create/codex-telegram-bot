import { useEffect, useState } from "react";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { readGitDiff, readGitStatus } from "../api.js";
import type { MobileGitDiff, MobileGitStatus } from "../types.js";
import { Badge, Button, Card } from "./ui/primitives.js";

export function GitPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [status, setStatus] = useState<MobileGitStatus>();
  const [diff, setDiff] = useState<MobileGitDiff>();
  const [view, setView] = useState<"unstaged" | "staged">("unstaged");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [nextStatus, nextDiff] = await Promise.all([readGitStatus(sessionId), readGitDiff(sessionId)]);
      setStatus(nextStatus);
      setDiff(nextDiff);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать Git"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [sessionId]);
  const patch = view === "staged" ? diff?.staged ?? "" : diff?.unstaged ?? "";

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="git-title" className="safe-area-top safe-area-bottom flex h-full max-h-[100svh] w-full max-w-3xl flex-col border-l border-border bg-background shadow-soft">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
        <GitBranch size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#a7c278]">{status?.project ?? "Проект"}</p><h2 id="git-title" className="truncate text-base font-semibold">Git и изменения</h2></div>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Обновить Git" onClick={() => void refresh()} disabled={loading}><RefreshCw size={17} className={loading ? "animate-spin" : ""} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть Git" onClick={onClose}><X size={18} /></Button>
      </header>
      {error && <p role="alert" className="m-4 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd] sm:mx-6">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading && !status ? <p className="text-sm text-muted">Читаю статус Git…</p> : status && <>
          <Card className="p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-muted">Текущая ветка</p><p className="mt-1 break-all font-mono text-sm">{status.branch || "не определена"}</p></div><Badge className={status.clean ? "border-[#3d5630] text-[#c7e89a]" : "text-[#f2c66d]"}>{status.clean ? "Чисто" : `${status.changes.length} изменений`}</Badge></div>
            {status.changes.length > 0 && <ul className="mt-4 divide-y divide-border">{status.changes.map((change, index) => <li key={`${change.code}-${change.path}-${index}`} className="flex gap-3 py-2 font-mono text-xs"><span className="shrink-0 text-[#c7e89a]">{change.code}</span><span className="break-all text-muted">{change.path}</span></li>)}</ul>}
          </Card>
          <div className="mt-5 flex gap-2"><Button variant={view === "unstaged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("unstaged")}>Рабочая папка</Button><Button variant={view === "staged" ? "outline" : "ghost"} className="min-h-10 px-3" onClick={() => setView("staged")}>Индекс</Button></div>
          <Card className="mt-3 min-h-48 overflow-auto"><pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[#dce3da] sm:p-4">{patch || (status.clean ? "Нет незакоммиченных изменений." : "Git не создал текстовый diff для этих изменений.")}</pre></Card>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">Просмотр только для чтения. Внешние diff-программы и textconv-фильтры выключены.</p>
        </>}
      </div>
    </section>
  </div>;
}
