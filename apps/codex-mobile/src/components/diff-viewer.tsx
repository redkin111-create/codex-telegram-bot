import { parseUnifiedDiff, type DiffLineKind } from "../lib/unified-diff.js";

const rowStyle: Record<DiffLineKind, string> = {
  file: "bg-[#171d19] font-semibold text-[#c7e89a]",
  hunk: "bg-[#18242b] text-[#9ed8ff]",
  add: "bg-[#14251a] text-[#c3f0b0]",
  remove: "bg-[#2c1918] text-[#ffc0b8]",
  context: "text-[#dce3da]",
  meta: "text-[#7b887e]",
};
const rowLabel: Record<DiffLineKind, string> = {
  file: "Файл",
  hunk: "Блок изменений",
  add: "Добавлено",
  remove: "Удалено",
  context: "Без изменений",
  meta: "Сведения",
};

export function DiffViewer({ patch, loading, emptyMessage }: { patch: string; loading: boolean; emptyMessage: string }) {
  if (loading) return <p role="status" className="p-4 font-mono text-xs text-muted">Читаю diff…</p>;
  const lines = parseUnifiedDiff(patch);
  if (!lines.length) return <p className="p-4 font-mono text-xs text-muted">{emptyMessage}</p>;
  return <div role="list" aria-label="Изменения по строкам" className="max-h-[42svh] overflow-auto py-2 font-mono text-[11px] leading-5 sm:max-h-[52svh]">
    {lines.map((line, index) => <div key={`${index}-${line.kind}`} role="listitem" data-diff-kind={line.kind}
      aria-label={`${rowLabel[line.kind]}${line.oldLine !== undefined ? `, старая строка ${line.oldLine}` : ""}${line.newLine !== undefined ? `, новая строка ${line.newLine}` : ""}: ${line.text}`}
      className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] gap-1 px-2 ${rowStyle[line.kind]}`}>
      <span aria-hidden="true" className="select-none text-right text-[#768278]">{line.oldLine ?? ""}</span>
      <span aria-hidden="true" className="select-none text-right text-[#768278]">{line.newLine ?? ""}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || " "}</span>
    </div>)}
  </div>;
}
