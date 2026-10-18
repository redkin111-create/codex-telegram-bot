import { useEffect, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import type { MobileApproval } from "../types.js";
import { Button, Card } from "./ui/primitives.js";

export function ApprovalPanel({ approval, onResolve, onClose }: {
  approval: MobileApproval;
  onResolve: (optionId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sessionApproval, setSessionApproval] = useState<string>();

  useEffect(() => setSessionApproval(undefined), [approval.id]);

  async function choose(optionId: string) {
    setBusy(true);
    setError("");
    try { await onResolve(optionId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось отправить решение"); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-3 sm:items-center" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="approval-title" className="safe-area-bottom w-full max-w-lg rounded-2xl border border-[#725d36] bg-[#1d1b15] p-4 shadow-soft sm:p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex gap-3"><span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#725d36] bg-[#302819] text-[#f2c66d]"><ShieldAlert size={18} /></span><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#f2c66d]">Требуется ваше решение</p><h2 id="approval-title" className="mt-1 text-base font-semibold leading-snug">{approval.title}</h2></div></div>
        <Button variant="ghost" className="min-h-9 px-2" aria-label="Скрыть запрос подтверждения" onClick={onClose} disabled={busy}><X size={17} /></Button>
      </header>
      {approval.summary && <Card className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap p-3 text-sm leading-relaxed text-muted">{approval.summary}</Card>}
      <p className="mt-3 text-xs text-muted">Тип действия: {approval.kind}. Codex продолжит только после выбранного решения.</p>
      {error && <p role="alert" className="mt-3 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]">{error}</p>}
      {sessionApproval && <Card role="alert" className="mt-4 border-[#725d36] bg-[#302819] p-3">
        <p className="text-sm leading-relaxed">Codex может разрешить похожие запросы без нового вопроса до конца этого сеанса.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-10" disabled={busy} onClick={() => setSessionApproval(undefined)}>Назад</Button>
          <Button type="button" className="min-h-10" disabled={busy} onClick={() => void choose(sessionApproval)}>Разрешить для сеанса</Button>
        </div>
      </Card>}
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">{approval.options.map((option) => {
        const reject = /deny|declin|reject|отклон|запрет/i.test(`${option.id} ${option.label}`);
        return <Button key={option.id} variant={reject ? "danger" : "default"} className="min-h-12 whitespace-normal" disabled={busy} onClick={() => {
          if (option.id === "codex-mobile-session-allow") setSessionApproval(option.id);
          else void choose(option.id);
        }}>{option.label}</Button>;
      })}</div>
    </section>
  </div>;
}
