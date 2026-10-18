import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { GitFork, ImagePlus, LoaderCircle, Minimize2, Play, Send, Sparkles, Square, Trash2, Wrench } from "lucide-react";
import "../../../../apps/mini-app/public/photo-input.js";
import type { HistoryEntry, MobileActivity, MobileCapabilities, MobileLiveEvent, MobileQueue, MobileSession } from "../types.js";
import { imageUrl } from "../api.js";
import { SafeMarkdown } from "../markdown.js";
import { isMobileSkillNameSafe, prependMobileSkill } from "../skill-prompt.js";
import { Badge, Button, Textarea } from "./ui/primitives.js";

export interface PromptImage { name: string; mimeType: string; data: string; preview: string; }
export type FollowUpMode = "queue" | "steer";

export function Conversation({
  session, history, activity, events, queue, connected, connecting, loading, streamConnected,
  error, includeTools, onToggleTools, onConnect, onCancel, onFork, forking, onCompact, compacting, onSend, onQueueRemove, onQueueResume, onQueueOpen, onLoadSkills,
}: {
  session?: MobileSession;
  history: HistoryEntry[];
  activity?: MobileActivity;
  events: MobileLiveEvent[];
  queue: MobileQueue;
  connected: boolean;
  connecting: boolean;
  loading: boolean;
  streamConnected: boolean;
  error: string;
  includeTools: boolean;
  onToggleTools: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onFork: () => void;
  forking: boolean;
  onCompact: () => Promise<void>;
  compacting: boolean;
  onSend: (text: string, images: PromptImage[], mode: FollowUpMode) => Promise<void>;
  onQueueRemove: (itemId: string) => void;
  onQueueResume: () => void;
  onQueueOpen: () => void;
  onLoadSkills: () => Promise<MobileCapabilities["skills"]>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [imageError, setImageError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [compactConfirm, setCompactConfirm] = useState(false);
  const [compactNotice, setCompactNotice] = useState("");
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>("queue");
  const [openImage, setOpenImage] = useState<{ path: string; name: string }>();
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerLoading, setSkillPickerLoading] = useState(false);
  const [skillPickerError, setSkillPickerError] = useState("");
  const [availableSkills, setAvailableSkills] = useState<MobileCapabilities["skills"]>([]);

  useEffect(() => {
    setSkillPickerOpen(false);
    setAvailableSkills([]);
    setSkillPickerError("");
  }, [session?.id]);

  async function toggleSkillPicker() {
    if (skillPickerOpen) { setSkillPickerOpen(false); return; }
    setSkillPickerOpen(true);
    setSkillPickerLoading(true);
    setSkillPickerError("");
    try { setAvailableSkills(await onLoadSkills()); }
    catch (cause) { setSkillPickerError(cause instanceof Error ? cause.message : "Не удалось загрузить навыки Codex"); }
    finally { setSkillPickerLoading(false); }
  }

  function chooseSkill(name: string) {
    try {
      setText((current) => prependMobileSkill(current, name));
      setSkillPickerOpen(false);
      setSkillPickerError("");
    } catch (cause) { setSkillPickerError(cause instanceof Error ? cause.message : "Не удалось выбрать навык"); }
  }

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setPreparing(true);
    setImageError("");
    try {
      const room = Math.max(0, window.CodexPhotos.max - images.length);
      if (files.length > room) throw new Error("Можно прикрепить не больше трёх изображений");
      const prepared: PromptImage[] = [];
      for (const file of Array.from(files)) prepared.push(await window.CodexPhotos.prepare(file));
      setImages((current) => [...current, ...prepared]);
    } catch (cause) { setImageError(cause instanceof Error ? cause.message : "Не удалось подготовить изображение"); }
    finally { setPreparing(false); }
  }

  async function submit() {
    if (!text.trim() && images.length === 0) return;
    try {
      await onSend(text.trim(), images, followUpMode);
      setText("");
      setImages([]);
      setFollowUpMode("queue");
    } catch { /* Keep the draft available after a rejected or uncertain request. */ }
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  if (!session) return <main className="flex min-w-0 flex-1 items-center justify-center p-5"><div className="max-w-sm text-center"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-panel text-accent"><Wrench size={22} /></div><h2 className="mt-5 text-lg font-semibold">Выберите сеанс</h2><p className="mt-2 text-sm leading-6 text-muted">Можно сначала просмотреть историю. Подключение понадобится, чтобы отправить задачу или управлять очередью.</p></div></main>;

  const status = session.archived ? "В архиве" : activity?.liveLabel || session.liveLabel || "Статус неизвестен";
  const turnBusy = session.busy || activity?.busy === true || queue.busy;
  const toolEvents = events.filter((event) => event.kind === "tool" || event.kind === "status" || event.kind === "activity").slice(-5);

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-transparent">
    <header className="sticky top-0 z-10 border-b border-border bg-[#111512]/95 px-4 py-3 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">{session.title || "Новый сеанс"}</h1><p className="mt-1 truncate font-mono text-[10px] text-muted">{session.cwd}</p></div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className={`${session.liveStatus === "working" ? "border-[#536441] text-[#d5f49c]" : session.liveStatus === "failed" ? "border-[#733b39] text-[#ffc3bd]" : ""}`}><span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${session.busy ? "animate-pulse bg-accent" : "bg-[#748073]"}`} />{status}</Badge>
          {!connected && <Button variant="outline" className="min-h-9 px-3 text-xs" onClick={onConnect} disabled={connecting}>{connecting ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}{session.archived ? "Восстановить" : "Подключить"}</Button>}
          {connected && session.busy && <Button variant="danger" className="min-h-9 px-3 text-xs" onClick={onCancel}><Square size={13} /> Остановить</Button>}
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={onFork} disabled={forking || turnBusy || session.archived} aria-label="Создать ответвление сеанса">
          {forking ? <LoaderCircle size={14} className="animate-spin" /> : <GitFork size={14} />}
          {forking ? "Создаю…" : "Создать ответвление"}
        </Button>
        {connected && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={() => { setCompactNotice(""); setCompactConfirm(true); }} disabled={compacting || turnBusy || session.archived} aria-label="Сократить контекст сеанса">
          {compacting ? <LoaderCircle size={14} className="animate-spin" /> : <Minimize2 size={14} />}
          Сократить контекст
        </Button>}
      </div>
      {toolEvents.length > 0 && <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5" aria-label="Текущие события Codex">
        {toolEvents.map((event) => <span key={`${event.id}-${event.kind}`} className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[11px] text-muted">{event.kind === "tool" ? <Wrench size={12} className="text-accent" /> : null}{event.label || event.status || "Событие"}</span>)}
      </div>}
      <p className="sr-only" role="status">{streamConnected ? "Поток Codex подключён" : "Поток Codex переподключается"}</p>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-5 md:px-8">
      {loading && history.length === 0 && <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Загружаю историю…</div>}
      {!loading && history.length === 0 && <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-border bg-panel/60 p-6 text-center"><p className="font-medium">История пока пустая</p><p className="mt-2 text-sm text-muted">Подключите сеанс и отправьте задачу.</p></div>}
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {history.map((entry, index) => entry.role === "tool" ? <details key={`${entry.timestamp ?? "t"}-${index}`} className="rounded-xl border border-border bg-[#151a16]">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-[#bac7b6]"><Wrench size={14} className="text-accent" />{entry.tool || "Инструмент"}<span className="ml-auto text-[#737f74]">Показать вывод</span></summary>
          <pre className="max-h-80 overflow-auto border-t border-border p-3 font-mono text-xs leading-5 text-[#d3dbd1]">{entry.text}</pre>
        </details> : <article key={`${entry.timestamp ?? "m"}-${index}`} className={`max-w-[94%] rounded-2xl border px-4 py-3 ${entry.role === "user" ? "ml-auto border-[#46533d] bg-[#20291b]" : "mr-auto border-border bg-panel"}`}>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-[#859084]">{entry.role === "user" ? "Вы" : entry.role === "system" ? "Система" : "Codex"}{entry.timestamp ? <time className="font-normal normal-case tracking-normal">{new Date(entry.timestamp).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</time> : null}</div>
          <SafeMarkdown text={entry.text} />
        </article>)}
      </div>

      {(activity?.images.length ?? 0) > 0 && <section className="mx-auto mt-6 max-w-4xl"><h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Скриншоты сеанса</h2><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{activity!.images.map((image) => <button type="button" key={image.path} onClick={() => setOpenImage({ path: image.path, name: image.name })} aria-label={"Открыть скриншот " + image.name} className="overflow-hidden rounded-xl border border-border bg-panel text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><img src={imageUrl(session.id, image.path)} alt={image.name} loading="lazy" className="aspect-video w-full object-cover" /><span className="block truncate px-2 py-1.5 text-xs text-muted">{image.name}</span></button>)}</div></section>}
    </div>

    {queueOpen && <section className="mx-3 mb-3 rounded-2xl border border-border bg-panel p-3 sm:mx-5 md:mx-8" aria-label="Очередь задач">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Очередь · {queue.items.length}</h2><div className="flex gap-2"><Button variant="outline" className="min-h-9 px-2.5 text-xs" onClick={onQueueResume} disabled={!queue.paused}><Play size={13} /> Возобновить</Button><Button variant="ghost" className="min-h-9 px-2" aria-label="Скрыть очередь" onClick={() => setQueueOpen(false)}>×</Button></div></div>
      <div className="max-h-40 space-y-2 overflow-y-auto">{queue.items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-xl bg-[#111613] px-3 py-2"><p className="min-w-0 flex-1 truncate text-xs text-muted">{item.text}</p><Button variant="ghost" className="min-h-8 px-2 text-[#c58980]" aria-label="Удалить из очереди" onClick={() => onQueueRemove(item.id)}><Trash2 size={14} /></Button></div>)}{queue.items.length === 0 && <p className="py-2 text-xs text-muted">В очереди нет задач.</p>}</div>
    </section>}

    {error && <p className="mx-3 mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd] sm:mx-5 md:mx-8" role="alert">{error}</p>}
    {imageError && <p className="mx-3 mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd] sm:mx-5 md:mx-8" role="alert">{imageError}</p>}
    {compactNotice && <p className="mx-3 mb-2 rounded-xl border border-[#46533d] bg-[#20291b] px-3 py-2 text-sm text-[#d5f49c] sm:mx-5 md:mx-8" role="status">{compactNotice}</p>}

    {connected && turnBusy && <div className="border-t border-border bg-[#141815] px-3 pt-2 sm:px-5 md:px-8" role="group" aria-label="Как передать следующее сообщение">
      <div className="mx-auto flex max-w-4xl gap-2">
        <button type="button" aria-pressed={followUpMode === "queue"} onClick={() => setFollowUpMode("queue")} className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${followUpMode === "queue" ? "border-[#60714f] bg-[#20291b] text-[#d5f49c]" : "border-border text-muted"}`}>В очередь</button>
        <button type="button" aria-pressed={followUpMode === "steer"} onClick={() => setFollowUpMode("steer")} className={`min-h-9 rounded-lg border px-3 text-xs font-medium ${followUpMode === "steer" ? "border-[#60714f] bg-[#20291b] text-[#d5f49c]" : "border-border text-muted"}`}>Направить сейчас</button>
      </div>
    </div>}
    <form className="safe-area-bottom border-t border-border bg-[#141815] px-3 py-3 sm:px-5 md:px-8" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {skillPickerOpen && <section className="mx-auto mb-2 max-h-48 max-w-4xl overflow-y-auto rounded-xl border border-border bg-panel p-3" aria-label="Выбрать навык Codex">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">Включённые навыки</h2><button type="button" className="min-h-8 px-2 text-xs text-muted" onClick={() => setSkillPickerOpen(false)}>Закрыть</button></div>
        {skillPickerLoading ? <p className="py-2 text-xs text-muted">Загружаю навыки…</p>
          : skillPickerError ? <p role="alert" className="py-2 text-xs text-[#ffc3bd]">{skillPickerError}</p>
            : availableSkills.filter((skill) => skill.enabled && skill.invokable && isMobileSkillNameSafe(skill.name)).length ? <ul className="space-y-1">{availableSkills.filter((skill) => skill.enabled && skill.invokable && isMobileSkillNameSafe(skill.name)).map((skill) => <li key={skill.name}>
              <button type="button" className="w-full rounded-lg px-2 py-2 text-left hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Использовать навык ${skill.name}`} onClick={() => chooseSkill(skill.name)}><span className="block break-words text-xs font-medium">${skill.name}</span>{skill.description && <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{skill.description}</span>}</button>
            </li>)}</ul> : <p className="py-2 text-xs text-muted">Нет включённых навыков, доступных для вызова.</p>}
      </section>}
      {images.length > 0 && <div className="mx-auto mb-2 flex max-w-4xl gap-2 overflow-x-auto">{images.map((image, index) => <div key={`${image.name}-${index}`} className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border border-border"><img src={image.preview} alt={image.name} className="h-full w-full object-cover" /><button type="button" aria-label={`Убрать ${image.name}`} className="absolute right-1 top-1 rounded-full bg-black/75 px-1.5 text-xs" onClick={() => setImages((current) => current.filter((_, i) => i !== index))}>×</button></div>)}</div>}
      <div className="mx-auto flex max-w-4xl items-end gap-2">
        <label className="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-[#1b211c] text-muted hover:text-accent" aria-label="Прикрепить фото">
          <ImagePlus size={19} />
          <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" multiple disabled={preparing || images.length >= 3} onChange={(event) => { void attach(event.target.files); event.target.value = ""; }} />
        </label>
        <Button type="button" variant="outline" className="min-h-11 w-11 shrink-0 px-0" aria-label="Выбрать навык Codex" disabled={!connected} onClick={() => void toggleSkillPicker()}><Sparkles size={18} /></Button>
        <div className="min-w-0 flex-1"><Textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={submitOnEnter} placeholder={!connected ? "Подключите сеанс, чтобы отправить задачу" : turnBusy && followUpMode === "steer" ? "Направление для текущей задачи…" : turnBusy ? "Следующая задача в очереди…" : "Задача для Codex…"} disabled={!connected} rows={2} className="min-h-[48px] max-h-40 resize-none py-3" aria-label="Сообщение Codex" /></div>
        <Button type="submit" className="min-h-12 w-12 shrink-0 px-0" disabled={!connected || (!text.trim() && images.length === 0) || preparing} aria-label={followUpMode === "steer" && turnBusy ? "Направить текущую задачу" : "Отправить задачу"}>{preparing ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}</Button>
      </div>
      <div className="mx-auto mt-2 flex max-w-4xl items-center justify-between text-[10px] text-[#758077]">
        <span>{connected ? "Enter отправляет · Shift+Enter переносит строку" : "История доступна без подключения"}</span>
        <div className="flex items-center gap-2"><button type="button" className="min-h-8 rounded-lg px-2 text-xs text-muted hover:bg-elevated" onClick={() => { setQueueOpen((value) => !value); onQueueOpen(); }}>Очередь {queue.items.length}</button><button type="button" className="min-h-8 rounded-lg px-2 text-xs text-muted hover:bg-elevated" aria-pressed={includeTools} onClick={onToggleTools}>{includeTools ? "Скрыть инструменты" : "Показать инструменты"}</button>{queue.busy && <span className="flex items-center gap-1"><LoaderCircle size={11} className="animate-spin" />Работает</span>}</div>
      </div>
    </form>
    {openImage && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-3 sm:p-8" role="dialog" aria-modal="true" aria-label={openImage.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenImage(undefined); }}>
      <Button variant="outline" className="absolute right-4 top-4 z-10 min-h-11 px-4" aria-label="Закрыть скриншот" onClick={() => setOpenImage(undefined)}>Закрыть</Button>
      <img src={imageUrl(session.id, openImage.path)} alt={openImage.name} className="max-h-[88svh] max-w-full rounded-xl object-contain" />
      <span className="sr-only">{openImage.name}</span>
    </div>}
    {compactConfirm && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !compacting) setCompactConfirm(false); }}>
      <section className="w-full max-w-md rounded-2xl border border-border bg-panel p-5 shadow-soft" role="dialog" aria-modal="true" aria-labelledby="compact-title" aria-describedby="compact-description">
        <h2 id="compact-title" className="text-base font-semibold">Сократить контекст сеанса?</h2>
        <p id="compact-description" className="mt-2 text-sm leading-6 text-muted">Codex подготовит краткое изложение старой части истории, чтобы освободить место для дальнейшей работы. Это действие изменит контекст сеанса.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={compacting} onClick={() => setCompactConfirm(false)}>Отмена</Button>
          <Button type="button" disabled={compacting || turnBusy} onClick={() => { setCompactNotice(""); void onCompact().then(() => { setCompactConfirm(false); setCompactNotice("Запрос принят Codex. Факт завершения будет показан только после подтверждения runtime."); }).catch(() => setCompactConfirm(false)); }}>
            {compacting ? <LoaderCircle size={15} className="animate-spin" /> : <Minimize2 size={15} />}Сократить контекст
          </Button>
        </div>
      </section>
    </div>}
  </main>;
}
