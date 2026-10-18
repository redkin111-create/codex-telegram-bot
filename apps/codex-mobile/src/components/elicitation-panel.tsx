import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { MobileElicitation, MobileElicitationAction, MobileElicitationField } from "../types.js";
import { Button, Card } from "./ui/primitives.js";

type FieldValue = string | boolean;

function initialValues(fields: MobileElicitationField[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((field) => [field.name, field.type === "boolean" ? false : ""]));
}

export function ElicitationPanel({ elicitation, onResolve, onClose }: {
  elicitation: MobileElicitation;
  onResolve: (action: MobileElicitationAction, content?: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const fields = elicitation.fields ?? [];
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValues(initialValues(elicitation.fields ?? []));
    setError("");
  }, [elicitation.id]);

  async function resolve(action: MobileElicitationAction, content?: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try { await onResolve(action, content); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось отправить ответ MCP"); }
    finally { setBusy(false); }
  }

  function setField(name: string, value: FieldValue) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function submitForm() {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.type === "boolean") {
        content[field.name] = value === true;
        continue;
      }
      if (typeof value !== "string") return setError(`Проверьте поле «${field.label}»`);
      if (!value && !field.required) continue;
      if (field.required && !value) return setError(`Заполните поле «${field.label}»`);
      if (field.type === "string") {
        if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 1000) ||
            field.options && !field.options.includes(value)) return setError(`Проверьте поле «${field.label}»`);
        content[field.name] = value;
        continue;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || field.type === "integer" && !Number.isInteger(number) ||
          field.minimum !== undefined && number < field.minimum || field.maximum !== undefined && number > field.maximum) {
        return setError(`Проверьте поле «${field.label}»`);
      }
      content[field.name] = number;
    }
    void resolve("accept", content);
  }

  return <div className="fixed inset-0 z-[61] flex items-end justify-center bg-black/70 p-3 sm:items-center" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="elicitation-title" className="safe-area-bottom max-h-[90svh] w-full max-w-lg overflow-auto rounded-2xl border border-border bg-[#171b18] p-4 shadow-soft sm:p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-accent">Запрос MCP · {elicitation.serverName}</p><h2 id="elicitation-title" className="mt-1 text-base font-semibold leading-snug">Ответ Codex-сервера</h2></div>
        <Button variant="ghost" className="min-h-9 px-2" aria-label="Скрыть запрос MCP" onClick={onClose} disabled={busy}><X size={17} /></Button>
      </header>
      <Card className="mt-4 whitespace-pre-wrap p-3 text-sm leading-relaxed text-muted">{elicitation.message}</Card>
      {elicitation.mode === "form" ? <div className="mt-4 space-y-4">
        {fields.map((field) => <ElicitationInput key={field.name} field={field} value={values[field.name] ?? ""} disabled={busy} onChange={(value) => setField(field.name, value)} />)}
      </div> : <div className="mt-4 rounded-xl border border-border bg-[#101411] p-3 text-sm">
        <p className="text-muted">Откроется защищённый сайт:</p>
        <a href={elicitation.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-10 items-center gap-2 text-accent underline underline-offset-4">
          {elicitation.urlHost}<ExternalLink size={15} />
        </a>
        <p className="mt-2 text-xs text-muted">Вернитесь сюда после завершения и нажмите «Готово».</p>
      </div>}
      {error && <p role="alert" className="mt-4 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => void resolve("cancel")}>Отмена</Button>
        <Button type="button" variant="danger" className="min-h-11" disabled={busy} onClick={() => void resolve("decline")}>Отклонить</Button>
        {elicitation.mode === "form"
          ? <Button type="button" className="min-h-11" disabled={busy} onClick={submitForm}>{busy ? "Отправляю…" : "Отправить ответ"}</Button>
          : <Button type="button" className="min-h-11" disabled={busy} onClick={() => void resolve("accept")}>{busy ? "Отправляю…" : "Готово"}</Button>}
      </div>
    </section>
  </div>;
}

function ElicitationInput({ field, value, disabled, onChange }: {
  field: MobileElicitationField;
  value: FieldValue;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
}) {
  if (field.type === "boolean") return <label className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-[#101411] px-3 text-sm">
    <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span>{field.label}{field.required ? " *" : ""}</span>
  </label>;

  const control = field.options
    ? <select aria-label={field.label} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} className="min-h-11 w-full rounded-xl border border-border bg-[#101411] px-3 text-sm text-text">
      <option value="">Выберите…</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
    : <input aria-label={field.label} type={field.type === "string" ? field.secret ? "password" : "text" : "number"}
      inputMode={field.type === "number" || field.type === "integer" ? "decimal" : undefined}
      step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
      min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength}
      value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}
      className="min-h-11 w-full rounded-xl border border-border bg-[#101411] px-3 text-sm text-text" />;

  return <label className="block space-y-1.5 text-sm">
    <span className="block text-xs font-medium text-muted">{field.label}{field.required ? " *" : ""}</span>
    {control}
    {field.description && <span className="block text-xs leading-relaxed text-muted">{field.description}</span>}
  </label>;
}
