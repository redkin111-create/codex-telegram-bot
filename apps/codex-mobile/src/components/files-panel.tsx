import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileCode2, Folder, Image as ImageIcon, Plus, Save, X } from "lucide-react";
import { projectImageUrl, readFileListing, readProjectFile } from "../api.js";
import type { MobileFile, MobileFileListing, MobileOperation } from "../types.js";
import { Button, Card, Input } from "./ui/primitives.js";

function sizeLabel(size?: number): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

export function FilesPanel({ sessionId, connected, onClose, onOperation }: {
  sessionId: string;
  connected: boolean;
  onClose: () => void;
  onOperation: (op: MobileOperation, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const [directory, setDirectory] = useState("");
  const [listing, setListing] = useState<MobileFileListing>();
  const [file, setFile] = useState<MobileFile>();
  const [imagePreview, setImagePreview] = useState<{ path: string; size?: number }>();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  async function refreshDirectory(path = directory) {
    setLoading(true);
    setError("");
    try { setListing(await readFileListing(sessionId, path)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось открыть папку"); }
    finally { setLoading(false); }
  }

  useEffect(() => { setDirectory(""); setFile(undefined); setImagePreview(undefined); void refreshDirectory(""); }, [sessionId]);

  const filteredEntries = useMemo(() => listing?.entries.filter((entry) => entry.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [], [listing, search]);
  const isDirty = Boolean(file && draft !== file.text);

  async function openEntry(name: string, kind: "directory" | "file") {
    const path = [directory, name].filter(Boolean).join("/");
    setError("");
    setSaved(false);
    if (kind === "directory") {
      setDirectory(path);
      setFile(undefined);
      setImagePreview(undefined);
      await refreshDirectory(path);
      return;
    }
    setLoading(true);
    try {
      if (/\.(?:png|jpe?g|webp|gif)$/i.test(name)) {
        const size = listing?.entries.find((entry) => entry.name === name)?.size;
        setFile(undefined);
        setDraft("");
        setImagePreview({ path, size });
        return;
      }
      const next = await readProjectFile(sessionId, path);
      setFile(next);
      setImagePreview(undefined);
      setDraft(next.text);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось прочитать файл"); }
    finally { setLoading(false); }
  }

  async function saveFile() {
    if (!file || !connected || !isDirty) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await onOperation("writeFile", { sessionId, path: file.path, content: draft, expectedHash: file.sha256 });
      const updated = await readProjectFile(sessionId, file.path);
      setFile(updated);
      setDraft(updated.text);
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить файл"); }
    finally { setSaving(false); }
  }

  async function createFile() {
    const name = newName.trim();
    if (!connected || !name || name.includes("/") || name.includes("\\")) return;
    const path = [directory, name].filter(Boolean).join("/");
    setSaving(true);
    setError("");
    try {
      await onOperation("createFile", { sessionId, path, content: "" });
      const next = await readProjectFile(sessionId, path);
      setFile(next);
      setDraft(next.text);
      setCreating(false);
      setNewName("");
      await refreshDirectory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать файл"); }
    finally { setSaving(false); }
  }

  function goBack() {
    if (file || imagePreview) { setFile(undefined); setImagePreview(undefined); setDraft(""); setSaved(false); void refreshDirectory(); return; }
    const parts = directory.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.join("/");
    setDirectory(parent);
    void refreshDirectory(parent);
  }

  const canGoBack = Boolean(file || imagePreview || directory);
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="files-title" className="safe-area-top safe-area-bottom flex h-full max-h-[100svh] w-full max-w-3xl flex-col border-l border-border bg-background shadow-soft">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
        {canGoBack && <Button variant="ghost" className="min-h-10 px-2" aria-label={file ? "Назад к файлам" : "На уровень выше"} onClick={goBack}><ArrowLeft size={18} /></Button>}
        <div className="min-w-0 flex-1"><p className="truncate text-[10px] font-bold uppercase tracking-[.18em] text-[#a7c278]">{listing?.project || file?.project || "Проект"}</p><h2 id="files-title" className="truncate text-base font-semibold">{file?.path || imagePreview?.path || (directory ? `${directory}/` : "Файлы проекта")}</h2></div>
        {file && <Button variant="default" className="min-h-10 px-3" disabled={!connected || !isDirty || saving} onClick={() => void saveFile()}><Save size={16} />{saving ? "Сохраняю" : "Сохранить"}</Button>}
        {!file && !imagePreview && <Button variant="outline" className="min-h-10 px-2" disabled={!connected || loading} aria-label="Создать файл" onClick={() => { setCreating((value) => !value); setError(""); }}><Plus size={17} /><span className="sr-only sm:not-sr-only">Новый</span></Button>}
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Закрыть файлы" onClick={onClose}><X size={18} /></Button>
      </header>
      {error && <p role="alert" className="m-3 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd] sm:mx-5">{error}</p>}
      {saved && <p role="status" className="mx-4 mt-3 text-sm text-[#c7e89a] sm:mx-5">Файл сохранён</p>}
      {creating && !file && <form className="flex shrink-0 gap-2 border-b border-border p-3 sm:px-5" onSubmit={(event) => { event.preventDefault(); void createFile(); }}>
        <Input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="например, new.ts" aria-label="Имя нового файла" />
        <Button type="submit" className="min-h-10 shrink-0 px-3" disabled={!connected || !newName.trim() || saving}>{saving ? "Создаю" : "Создать"}</Button>
      </form>}
      {imagePreview ? <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-5">
        <Card className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-5">
          <img src={projectImageUrl(sessionId, imagePreview.path)} alt={`Предпросмотр ${imagePreview.path}`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setError("Не удалось безопасно загрузить изображение")}
            className="max-h-[68svh] max-w-full rounded-lg object-contain" />
        </Card>
        <p className="text-[11px] text-muted">{sizeLabel(imagePreview.size)} · Только растровый предпросмотр. SVG и другие активные форматы не исполняются.</p>
      </div> : file ? <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
        {!connected && <p className="mb-3 text-xs text-muted">Чтобы редактировать, подключите этот сеанс к мобильному клиенту. Чтение доступно без подключения.</p>}
        <textarea aria-label={`Содержимое ${file.path}`} spellCheck={false} value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); }} readOnly={!connected} className="min-h-0 flex-1 resize-none rounded-xl border border-border bg-[#0d110e] p-3 font-mono text-xs leading-relaxed text-[#dce3da] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 read-only:opacity-80 sm:p-4" />
        <p className="mt-2 flex items-center justify-between text-[11px] text-muted"><span>{sizeLabel(file.size)} · UTF-8</span>{isDirty && <span className="text-[#f2c66d]">Есть несохранённые изменения</span>}</p>
      </div> : <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <label className="mb-3 block"><span className="sr-only">Фильтр файлов</span><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти файл в этой папке" aria-label="Найти файл в папке" /></label>
        {loading && <p className="p-3 text-sm text-muted">Загружаю папку…</p>}
        {!loading && filteredEntries.length === 0 && <p className="p-4 text-center text-sm text-muted">В этой папке нет подходящих файлов.</p>}
        <Card className="divide-y divide-border overflow-hidden">
          {filteredEntries.map((entry) => <button key={entry.name} className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" onClick={() => void openEntry(entry.name, entry.kind)}>
            {entry.kind === "directory" ? <Folder size={17} className="shrink-0 text-[#c6e597]" /> : /\.(?:png|jpe?g|webp|gif)$/i.test(entry.name) ? <ImageIcon size={17} className="shrink-0 text-muted" /> : <FileCode2 size={17} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
            {entry.kind === "file" && <span className="shrink-0 text-[11px] text-muted">{sizeLabel(entry.size)}</span>}
          </button>)}
        </Card>
        <p className="mt-4 text-[11px] leading-relaxed text-muted">Секретные файлы, каталоги сборки и символические ссылки скрыты. Текстовые файлы ограничены 512 КБ.</p>
      </div>}
    </section>
  </div>;
}
