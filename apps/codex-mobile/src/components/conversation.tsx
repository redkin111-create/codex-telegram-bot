import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { FileText, GitFork, ImagePlus, LoaderCircle, MessageSquare, Minimize2, Paperclip, Pencil, Play, Plug, Search, Send, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import "../../../../apps/mini-app/public/photo-input.js";
import type { HistoryEntry, MobileActivity, MobileAttachment, MobileCapabilities, MobileEditableTurn, MobileEditableTurns, MobileHistorySearch, MobileLiveEvent, MobileQueue, MobileScreenshotPage, MobileSession } from "../types.js";
import { imageUrl } from "../api.js";
import { splitCodeReviewComments } from "../lib/review-comments.js";
import { SafeMarkdown } from "../markdown.js";
import { isMobileSkillNameSafe, prependMobileSkill } from "../skill-prompt.js";
import { ScreenshotsGallery } from "./screenshots-gallery.js";
import { Badge, Button, Input, Textarea } from "./ui/primitives.js";

export interface PromptImage { name: string; mimeType: string; data: string; preview: string; }
export type FollowUpMode = "queue" | "steer";

export function Conversation({
  session, history, activity, events, queue, connected, connecting, loading, streamConnected,
  error, includeTools, onToggleTools, onConnect, onCancel, onFork, forking, onCreateSideChat, sideChatting, onReturnToParent, onCompact, compacting, onSend, onQueueRemove, onQueueResume, onQueueOpen, onLoadSkills, onLoadApps,
  onLoadEditableTurns, onEditAndRetry, onUploadAttachment, onRemoveAttachment, onOpenReviewLocation, onSearchHistory, onLoadOlderScreenshots,
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
  onCreateSideChat: () => void;
  sideChatting: boolean;
  onReturnToParent: () => void;
  onCompact: () => Promise<void>;
  compacting: boolean;
  onSend: (text: string, images: PromptImage[], attachments: MobileAttachment[], mode: FollowUpMode, appIds: string[]) => Promise<void>;
  onQueueRemove: (itemId: string) => void;
  onQueueResume: () => void;
  onQueueOpen: () => void;
  onLoadSkills: () => Promise<MobileCapabilities["skills"]>;
  onLoadApps: () => Promise<MobileCapabilities["apps"]>;
  onLoadEditableTurns: () => Promise<MobileEditableTurns>;
  onEditAndRetry: (turnId: string, text: string, expectedLatestTurnId: string) => Promise<void>;
  onUploadAttachment: (sessionId: string, file: File) => Promise<MobileAttachment>;
  onRemoveAttachment: (sessionId: string, id: string) => Promise<{ removed: boolean }>;
  onOpenReviewLocation: (location: { path: string; line?: number }) => void;
  onSearchHistory: (query: string, beforeOffset?: number, revision?: string) => Promise<MobileHistorySearch>;
  onLoadOlderScreenshots: (sessionId: string, beforeOffset?: number) => Promise<MobileScreenshotPage>;
}) {
  const activeSessionId = useRef(session?.id);
  activeSessionId.current = session?.id;
  const editLoadRequest = useRef(0);
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [attachments, setAttachments] = useState<MobileAttachment[]>([]);
  const [imageError, setImageError] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [compactConfirm, setCompactConfirm] = useState(false);
  const [compactNotice, setCompactNotice] = useState("");
  const [compactAwaitingConfirmation, setCompactAwaitingConfirmation] = useState(false);
  const compactEventStart = useRef(0);
  const compactConfirmationSeen = useRef(false);
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>("queue");
  const [openImage, setOpenImage] = useState<{ path: string; name: string }>();
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerLoading, setSkillPickerLoading] = useState(false);
  const [skillPickerError, setSkillPickerError] = useState("");
  const [availableSkills, setAvailableSkills] = useState<MobileCapabilities["skills"]>([]);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPickerLoading, setAppPickerLoading] = useState(false);
  const [appPickerError, setAppPickerError] = useState("");
  const [availableApps, setAvailableApps] = useState<MobileCapabilities["apps"]>([]);
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editTurns, setEditTurns] = useState<MobileEditableTurn[]>([]);
  const [editLatestTurnId, setEditLatestTurnId] = useState("");
  const [editTurn, setEditTurn] = useState<MobileEditableTurn>();
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState("");
  const [editNotice, setEditNotice] = useState("");
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [fullHistoryQuery, setFullHistoryQuery] = useState("");
  const [fullHistoryResults, setFullHistoryResults] = useState<MobileHistorySearch>();
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  const [fullHistoryError, setFullHistoryError] = useState("");
  const fullHistoryRequest = useRef(0);
  const usesFullHistory = Boolean(fullHistoryResults && fullHistoryQuery === historySearch.trim());
  const visibleHistory = useMemo(() => {
    if (usesFullHistory) return fullHistoryResults?.entries ?? [];
    const query = historySearch.trim().toLowerCase();
    if (!query) return history;
    return history.filter((entry) => entry.text.toLowerCase().includes(query));
  }, [history, historySearch, usesFullHistory, fullHistoryResults]);

  useEffect(() => {
    editLoadRequest.current++;
    setHistorySearchOpen(false);
    setHistorySearch("");
    setCompactNotice("");
    setCompactAwaitingConfirmation(false);
    compactEventStart.current = 0;
    compactConfirmationSeen.current = false;
    fullHistoryRequest.current++;
    setFullHistoryQuery("");
    setFullHistoryResults(undefined);
    setFullHistoryLoading(false);
    setFullHistoryError("");
    setSkillPickerOpen(false);
    setAvailableSkills([]);
    setSkillPickerError("");
    setAppPickerOpen(false);
    setAppPickerLoading(false);
    setAppPickerError("");
    setAvailableApps([]);
    setSelectedAppIds([]);
    setEditOpen(false);
    setEditLoading(false);
    setEditSaving(false);
    setEditTurns([]);
    setEditLatestTurnId("");
    setEditTurn(undefined);
    setEditError("");
    setEditNotice("");
    setAttachments([]);
    setAttachmentError("");
  }, [session?.id]);

  useEffect(() => {
    if (!compactAwaitingConfirmation || !session?.id) return;
    const confirmed = events.some((event) => event.kind === "compaction" && event.sessionId === session.id && event.id > compactEventStart.current);
    if (confirmed) {
      compactConfirmationSeen.current = true;
      setCompactAwaitingConfirmation(false);
      setCompactNotice("Codex подтвердил сокращение контекста.");
    }
  }, [events, compactAwaitingConfirmation, session?.id]);

  useEffect(() => {
    if (!compactAwaitingConfirmation) return;
    const timeout = window.setTimeout(() => {
      if (compactConfirmationSeen.current) return;
      setCompactAwaitingConfirmation(false);
      setCompactNotice("Статус неизвестен: Codex не подтвердил завершение сокращения контекста.");
    }, 60_000);
    return () => window.clearTimeout(timeout);
  }, [compactAwaitingConfirmation]);

  async function searchFullHistory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = historySearch.trim();
    if (query.length < 2 || fullHistoryLoading) return;
    const request = ++fullHistoryRequest.current;
    const targetSessionId = activeSessionId.current;
    setFullHistoryLoading(true);
    setFullHistoryError("");
    setFullHistoryResults(undefined);
    setFullHistoryQuery("");
    try {
      const result = await onSearchHistory(query);
      if (request !== fullHistoryRequest.current || activeSessionId.current !== targetSessionId) return;
      setFullHistoryResults(result);
      setFullHistoryQuery(query);
    } catch (cause) {
      if (request === fullHistoryRequest.current && activeSessionId.current === targetSessionId) {
        setFullHistoryError(cause instanceof Error ? cause.message : "Не удалось проверить всю историю");
      }
    } finally {
      if (request === fullHistoryRequest.current && activeSessionId.current === targetSessionId) setFullHistoryLoading(false);
    }
  }

  async function loadOlderHistoryMatches() {
    const current = fullHistoryResults;
    const query = fullHistoryQuery;
    if (!current?.nextOffset || fullHistoryLoading || !query) return;
    const request = fullHistoryRequest.current;
    const targetSessionId = activeSessionId.current;
    setFullHistoryLoading(true);
    setFullHistoryError("");
    try {
      const older = await onSearchHistory(query, current.nextOffset, current.revision);
      if (request !== fullHistoryRequest.current || activeSessionId.current !== targetSessionId || historySearch.trim() !== query) return;
      setFullHistoryResults((latest) => {
        if (!latest || latest.revision !== current.revision || latest.nextOffset !== current.nextOffset) return latest;
        return { ...older, entries: [...older.entries, ...latest.entries] };
      });
    } catch (cause) {
      if (request === fullHistoryRequest.current && activeSessionId.current === targetSessionId) {
        setFullHistoryError(cause instanceof Error ? cause.message : "Не удалось загрузить старые совпадения");
      }
    } finally {
      if (request === fullHistoryRequest.current && activeSessionId.current === targetSessionId) setFullHistoryLoading(false);
    }
  }

  useEffect(() => {
    fullHistoryRequest.current++;
    setFullHistoryQuery("");
    setFullHistoryResults(undefined);
    setFullHistoryLoading(false);
    setFullHistoryError("");
  }, [includeTools]);

  async function openEditDialog() {
    const targetSessionId = activeSessionId.current;
    const requestId = ++editLoadRequest.current;
    setEditOpen(true);
    setEditLoading(true);
    setEditTurns([]);
    setEditLatestTurnId("");
    setEditTurn(undefined);
    setEditText("");
    setEditError("");
    setEditNotice("");
    try {
      const result = await onLoadEditableTurns();
      if (requestId !== editLoadRequest.current || activeSessionId.current !== targetSessionId) return;
      const turns = Array.isArray(result.turns) ? result.turns : [];
      const latestTurnId = typeof result.latestTurnId === "string" ? result.latestTurnId : "";
      const initial = turns.find((turn) => turn.editable) ?? turns[0];
      setEditTurns(turns);
      setEditLatestTurnId(latestTurnId);
      setEditTurn(initial);
      setEditText(initial?.text ?? "");
    } catch (cause) {
      if (requestId === editLoadRequest.current && activeSessionId.current === targetSessionId) {
        setEditError(cause instanceof Error ? cause.message : "Не удалось загрузить запросы Codex");
      }
    } finally {
      if (requestId === editLoadRequest.current && activeSessionId.current === targetSessionId) setEditLoading(false);
    }
  }

  async function submitEdit() {
    if (!editTurn?.editable || !editTurn.turnId || !editLatestTurnId || !editText.trim() || editSaving) return;
    const targetSessionId = activeSessionId.current;
    setEditSaving(true);
    setEditError("");
    try {
      await onEditAndRetry(editTurn.turnId, editText.trim(), editLatestTurnId);
      if (activeSessionId.current !== targetSessionId) return;
      setEditOpen(false);
      setEditNotice("Запрос заменён. Более поздняя история удалена; файлы и команды сами не откатывались.");
    } catch (cause) {
      if (activeSessionId.current === targetSessionId) setEditError(cause instanceof Error ? cause.message : "Не удалось повторно отправить запрос");
    } finally {
      if (activeSessionId.current === targetSessionId) setEditSaving(false);
    }
  }

  async function toggleSkillPicker() {
    if (skillPickerOpen) { setSkillPickerOpen(false); return; }
    setSkillPickerOpen(true);
    setSkillPickerLoading(true);
    setSkillPickerError("");
    try { setAvailableSkills(await onLoadSkills()); }
    catch (cause) { setSkillPickerError(cause instanceof Error ? cause.message : "Не удалось загрузить навыки Codex"); }
    finally { setSkillPickerLoading(false); }
  }

  async function toggleAppPicker() {
    if (appPickerOpen) { setAppPickerOpen(false); return; }
    setAppPickerOpen(true);
    setAppPickerLoading(true);
    setAppPickerError("");
    try { setAvailableApps(await onLoadApps()); }
    catch (cause) { setAppPickerError(cause instanceof Error ? cause.message : "Не удалось загрузить приложения Codex"); }
    finally { setAppPickerLoading(false); }
  }

  function toggleSelectedApp(id: string) {
    setSelectedAppIds((current) => {
      if (current.includes(id)) return current.filter((selected) => selected !== id);
      if (current.length >= 3) {
        setAppPickerError("Можно выбрать не больше трёх приложений для одного сообщения");
        return current;
      }
      setAppPickerError("");
      return [...current, id];
    });
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

  async function attachDocuments(files: FileList | null) {
    if (!files?.length || !session) return;
    const targetSessionId = session.id;
    setUploadingAttachments(true);
    setAttachmentError("");
    try {
      const selected = Array.from(files);
      if (attachments.length + selected.length > 5) throw new Error("Можно прикрепить не больше пяти файлов");
      for (const file of selected) {
        const prepared = await onUploadAttachment(targetSessionId, file);
        if (activeSessionId.current !== targetSessionId) {
          await onRemoveAttachment(targetSessionId, prepared.id).catch(() => undefined);
          return;
        }
        setAttachments((current) => [...current, prepared]);
      }
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "Не удалось прикрепить файл");
    } finally { setUploadingAttachments(false); }
  }

  async function removeDocument(id: string) {
    if (!session) return;
    setAttachmentError("");
    try {
      const result = await onRemoveAttachment(session.id, id);
      if (!result.removed) throw new Error("Файл уже отправлен или истёк. Обновите сеанс.");
      setAttachments((current) => current.filter((file) => file.id !== id));
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "Не удалось удалить вложение");
    }
  }

  async function submit() {
    if (!text.trim() && images.length === 0 && attachments.length === 0) return;
    if (followUpMode === "steer" && turnBusy && attachments.length > 0) {
      setAttachmentError("Файлы можно отправить в очередь. Для активной задачи используйте режим «В очередь».");
      return;
    }
    try {
      await onSend(text.trim(), images, attachments, followUpMode, selectedAppIds);
      setText("");
      setImages([]);
      setAttachments([]);
      setSelectedAppIds([]);
      setAttachmentError("");
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
  const toolEvents = events.filter((event) => event.kind === "tool" || event.kind === "status" || event.kind === "activity" || event.kind === "compaction").slice(-5);
  const currentPlanEvent = [...events].reverse().find((event) => event.kind === "plan");
  const currentPlan = currentPlanEvent?.plan ?? [];
  const completedPlanSteps = currentPlan.filter((step) => step.status === "completed").length;

  return <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-transparent">
    <header className="sticky top-0 z-10 border-b border-border bg-[#111512]/95 px-4 py-3 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">{session.title || "Новый сеанс"}</h1><p className="mt-1 truncate font-mono text-[10px] text-muted">{session.cwd}</p>{session.ephemeral && <p className="mt-1 text-[10px] text-accent">Временный side chat · не сохраняется в истории Desktop</p>}</div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge className={`${session.liveStatus === "working" ? "border-[#536441] text-[#d5f49c]" : session.liveStatus === "failed" ? "border-[#733b39] text-[#ffc3bd]" : ""}`}><span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${session.busy ? "animate-pulse bg-accent" : "bg-[#748073]"}`} />{status}</Badge>
          {!connected && <Button variant="outline" className="min-h-9 px-3 text-xs" onClick={onConnect} disabled={connecting}>{connecting ? <LoaderCircle size={14} className="animate-spin" /> : <Play size={14} />}{session.archived ? "Восстановить" : "Подключить"}</Button>}
          {connected && session.busy && <Button variant="danger" className="min-h-9 px-3 text-xs" onClick={onCancel}><Square size={13} /> Остановить</Button>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label="Найти в истории" aria-pressed={historySearchOpen} onClick={() => {
          if (historySearchOpen) {
            setHistorySearch("");
            fullHistoryRequest.current++;
            setFullHistoryResults(undefined);
            setFullHistoryQuery("");
            setFullHistoryError("");
          }
          setHistorySearchOpen((value) => !value);
        }}><Search size={14} />Поиск</Button>
        {session.ephemeral && session.parentThreadId ? <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={onReturnToParent} aria-label="Вернуться к исходному сеансу"><GitFork size={14} />К исходному сеансу</Button> : !session.archived && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={onCreateSideChat} disabled={sideChatting} aria-label="Спросить в side chat">
          {sideChatting ? <LoaderCircle size={14} className="animate-spin" /> : <MessageSquare size={14} />}
          {sideChatting ? "Открываю…" : "Спросить в side chat"}
        </Button>}
        {!session.ephemeral && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={onFork} disabled={forking || turnBusy || session.archived} aria-label="Создать ответвление сеанса">
          {forking ? <LoaderCircle size={14} className="animate-spin" /> : <GitFork size={14} />}
          {forking ? "Создаю…" : "Создать ответвление"}
        </Button>}
        {connected && !session.ephemeral && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={() => { setCompactNotice(""); setCompactConfirm(true); }} disabled={compacting || compactAwaitingConfirmation || turnBusy || session.archived} aria-label="Сократить контекст сеанса">
          {compacting ? <LoaderCircle size={14} className="animate-spin" /> : <Minimize2 size={14} />}
          Сократить контекст
        </Button>}
        {connected && !session.archived && !session.ephemeral && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={() => void openEditDialog()} disabled={turnBusy || editLoading || editSaving} aria-label="Редактировать запрос из истории">
          {editLoading ? <LoaderCircle size={14} className="animate-spin" /> : <Pencil size={14} />}
          Редактировать запрос
        </Button>}
      </div>
      {toolEvents.length > 0 && <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5" aria-label="Текущие события Codex">
        {toolEvents.map((event) => <span key={`${event.id}-${event.kind}`} className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[11px] text-muted">{event.kind === "tool" ? <Wrench size={12} className="text-accent" /> : null}{event.label || event.status || "Событие"}</span>)}
      </div>}
      {currentPlan.length > 0 && <section className="mx-auto mt-3 max-w-4xl rounded-xl border border-border bg-panel px-3 py-2.5" aria-label="План текущего задания">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xs font-semibold">План задания</h2><span className="shrink-0 text-[11px] text-muted">{completedPlanSteps} из {currentPlan.length} готово</span></div>
        {currentPlanEvent?.explanation && <p className="mt-1 text-[11px] leading-4 text-muted">{currentPlanEvent.explanation}</p>}
        <ol className="mt-2 max-h-36 space-y-1 overflow-y-auto" aria-label="Шаги плана">
          {currentPlan.map((step, index) => <li key={`${index}-${step.step}`} className="flex items-start gap-2 text-xs leading-5">
            <span className={`mt-1 shrink-0 text-[10px] ${step.status === "completed" ? "text-[#a7c278]" : step.status === "inProgress" ? "text-accent" : "text-muted"}`} aria-label={step.status === "completed" ? "Готово" : step.status === "inProgress" ? "Выполняется" : "Ожидает"}>{step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}</span>
            <span className="min-w-0 flex-1 break-words">{step.step}</span>
            <span className="shrink-0 text-[10px] text-muted">{step.status === "completed" ? "Готово" : step.status === "inProgress" ? "Сейчас" : "Дальше"}</span>
          </li>)}
        </ol>
      </section>}
      {historySearchOpen && <div className="mx-auto mt-3 w-full max-w-4xl" role="search" aria-label="Поиск по всей истории сеанса">
        <form className="flex items-center gap-2" onSubmit={(event) => void searchFullHistory(event)}>
          <label className="relative min-w-0 flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3.5 text-muted" /><Input value={historySearch} onChange={(event) => { fullHistoryRequest.current++; setFullHistoryLoading(false); setFullHistoryResults(undefined); setFullHistoryQuery(""); setHistorySearch(event.target.value); setFullHistoryError(""); }} placeholder="Найти текст во всём сеансе" aria-label="Поиск по всей истории сеанса" className="pl-9" /></label>
          <Button type="submit" variant="outline" className="min-h-10 shrink-0 px-3 text-xs" aria-label="Найти во всей истории" disabled={historySearch.trim().length < 2 || fullHistoryLoading}>
            {fullHistoryLoading ? <LoaderCircle size={14} className="animate-spin" /> : <Search size={14} />}{fullHistoryLoading ? "Ищу…" : "Искать всё"}
          </Button>
          <Button type="button" variant="ghost" className="min-h-10 px-2" aria-label="Закрыть поиск по истории" onClick={() => { setHistorySearch(""); setHistorySearchOpen(false); fullHistoryRequest.current++; setFullHistoryResults(undefined); setFullHistoryQuery(""); setFullHistoryError(""); }}><X size={16} /></Button>
        </form>
        <p className="mt-1 text-[11px] text-muted" role="status" aria-live="polite">
          {fullHistoryError ? fullHistoryError : usesFullHistory
            ? `По всему сеансу найдено: ${fullHistoryResults?.total ?? 0} · загружено: ${fullHistoryResults?.entries.length ?? 0}${fullHistoryResults?.skippedLargeRecords ? ` · пропущено крупных записей: ${fullHistoryResults.skippedLargeRecords}` : ""}`
            : historySearch.trim() ? `Совпадений в загруженной части: ${visibleHistory.length}` : `Загружено сообщений: ${history.length}`}
        </p>
        {usesFullHistory && fullHistoryResults?.nextOffset !== undefined && <Button type="button" variant="outline" className="mt-2 min-h-10 px-3 text-xs" onClick={() => void loadOlderHistoryMatches()} disabled={fullHistoryLoading}>
          {fullHistoryLoading ? <LoaderCircle size={14} className="animate-spin" /> : <Search size={14} />}
          {fullHistoryLoading ? "Загружаю…" : `Показать старые совпадения (ещё ${fullHistoryResults.nextOffset})`}
        </Button>}
      </div>}
      <p className="sr-only" role="status">{streamConnected ? "Поток Codex подключён" : "Поток Codex переподключается"}</p>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-5 md:px-8">
      {loading && history.length === 0 && <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Загружаю историю…</div>}
      {!loading && history.length === 0 && !historySearch.trim() && <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-border bg-panel/60 p-6 text-center"><p className="font-medium">История пока пустая</p><p className="mt-2 text-sm text-muted">Подключите сеанс и отправьте задачу.</p></div>}
      {!loading && historySearch.trim() && visibleHistory.length === 0 && <div className="mx-auto mt-10 max-w-md rounded-2xl border border-dashed border-border bg-panel/60 p-6 text-center"><p className="font-medium">{usesFullHistory ? "Совпадений во всём сеансе нет" : "В загруженной части совпадений нет"}</p><p className="mt-2 text-sm text-muted">{usesFullHistory ? "Измените запрос, чтобы искать другой текст." : "Нажмите «Искать всё», чтобы проверить старые сообщения."}</p><Button type="button" variant="outline" className="mt-4" onClick={() => { setHistorySearch(""); setFullHistoryResults(undefined); setFullHistoryQuery(""); }}>Очистить поиск</Button></div>}
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {visibleHistory.map((entry, index) => entry.role === "tool" ? <details key={`${entry.timestamp ?? "t"}-${index}`} className="rounded-xl border border-border bg-[#151a16]">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-[#bac7b6]"><Wrench size={14} className="text-accent" />{entry.tool || "Инструмент"}<span className="ml-auto text-[#737f74]">Показать вывод</span></summary>
          <pre className="max-h-80 overflow-auto border-t border-border p-3 font-mono text-xs leading-5 text-[#d3dbd1]">{entry.text}</pre>
        </details> : <article key={`${entry.timestamp ?? "m"}-${index}`} className={`max-w-[94%] rounded-2xl border px-4 py-3 ${entry.role === "user" ? "ml-auto border-[#46533d] bg-[#20291b]" : "mr-auto border-border bg-panel"}`}>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-[#859084]">{entry.role === "user" ? "Вы" : entry.role === "system" ? "Система" : "Codex"}{entry.timestamp ? <time className="font-normal normal-case tracking-normal">{new Date(entry.timestamp).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</time> : null}</div>
          {entry.role === "assistant" ? <div className="space-y-3">{splitCodeReviewComments(entry.text).map((segment, segmentIndex) => segment.type === "comment" ? <section key={`review-${segmentIndex}`} className="rounded-xl border border-[#5f4d2d] bg-[#292316] p-3" aria-label={`Комментарий ревью: ${segment.file}`}>
            <div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-semibold uppercase tracking-wide text-[#f0d995]">Замечание ревью</span>{segment.priority !== undefined && <Badge className="border-[#735d35] text-[#f0d995]">P{segment.priority}</Badge>}</div>
            <h3 className="mt-2 break-words text-sm font-semibold text-[#f4e4b2]">{segment.title}</h3>
            <p className="mt-1 break-all font-mono text-[11px] text-[#c8b783]">{segment.file}{segment.start !== undefined ? `:${segment.start}${segment.end !== undefined && segment.end !== segment.start ? `–${segment.end}` : ""}` : ""}</p>
            <div className="mt-2 text-xs leading-5 text-[#e7dfc9]"><SafeMarkdown text={segment.body} /></div>
            <Button type="button" variant="ghost" className="mt-2 min-h-9 px-2 text-xs" onClick={() => onOpenReviewLocation({ path: segment.file, ...(segment.start === undefined ? {} : { line: segment.start }) })}>Открыть diff</Button>
          </section> : segment.text ? <SafeMarkdown key={`text-${segmentIndex}`} text={segment.text} /> : null)}</div> : <SafeMarkdown text={entry.text} />}
        </article>)}
      </div>

      {session && <ScreenshotsGallery key={session.id} sessionId={session.id} images={activity?.images ?? []} onLoadOlder={onLoadOlderScreenshots} onOpenImage={setOpenImage} />}
    </div>

    {queueOpen && <section className="mx-3 mb-3 rounded-2xl border border-border bg-panel p-3 sm:mx-5 md:mx-8" aria-label="Очередь задач">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Очередь · {queue.items.length}</h2><div className="flex gap-2"><Button variant="outline" className="min-h-9 px-2.5 text-xs" onClick={onQueueResume} disabled={!queue.paused}><Play size={13} /> Возобновить</Button><Button variant="ghost" className="min-h-9 px-2" aria-label="Скрыть очередь" onClick={() => setQueueOpen(false)}>×</Button></div></div>
      <div className="max-h-40 space-y-2 overflow-y-auto">{queue.items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-xl bg-[#111613] px-3 py-2"><p className="min-w-0 flex-1 truncate text-xs text-muted">{item.text}</p><Button variant="ghost" className="min-h-8 px-2 text-[#c58980]" aria-label="Удалить из очереди" onClick={() => onQueueRemove(item.id)}><Trash2 size={14} /></Button></div>)}{queue.items.length === 0 && <p className="py-2 text-xs text-muted">В очереди нет задач.</p>}</div>
    </section>}

    {error && <p className="mx-3 mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd] sm:mx-5 md:mx-8" role="alert">{error}</p>}
    {imageError && <p className="mx-3 mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd] sm:mx-5 md:mx-8" role="alert">{imageError}</p>}
    {attachmentError && <p className="mx-3 mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd] sm:mx-5 md:mx-8" role="alert">{attachmentError}</p>}
    {compactNotice && <p className={`mx-3 mb-2 rounded-xl border px-3 py-2 text-sm sm:mx-5 md:mx-8 ${compactNotice.startsWith("Статус неизвестен") || compactNotice.includes("не подтвердил") ? "border-[#735c35] bg-[#302719] text-[#f0d995]" : "border-[#46533d] bg-[#20291b] text-[#d5f49c]"}`} role="status">{compactNotice}</p>}
    {editNotice && <p className="mx-3 mb-2 rounded-xl border border-[#46533d] bg-[#20291b] px-3 py-2 text-sm text-[#d5f49c] sm:mx-5 md:mx-8" role="status">{editNotice}</p>}

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
      {appPickerOpen && <section className="mx-auto mb-2 max-h-56 max-w-4xl overflow-y-auto rounded-xl border border-border bg-panel p-3" aria-label="Выбрать приложение Codex">
        <div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">Подключённые приложения</h2><button type="button" className="min-h-8 px-2 text-xs text-muted" onClick={() => setAppPickerOpen(false)}>Закрыть</button></div>
        {appPickerLoading ? <p className="py-2 text-xs text-muted">Загружаю приложения…</p>
          : appPickerError ? <p role="alert" className="py-2 text-xs text-[#ffc3bd]">{appPickerError}</p>
            : availableApps.filter((app) => app.enabled && app.accessible && app.callable).length ? <ul className="space-y-1">{availableApps.filter((app) => app.enabled && app.accessible && app.callable).map((app) => {
              const chosen = selectedAppIds.includes(app.id);
              return <li key={app.id}><button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-pressed={chosen} aria-label={`${chosen ? "Убрать" : "Добавить"} приложение ${app.name}`} onClick={() => toggleSelectedApp(app.id)}><span className="min-w-0"><span className="block truncate text-xs font-medium">{app.name}</span>{app.description && <span className="mt-0.5 block truncate text-[11px] text-muted">{app.description}</span>}</span><span className="shrink-0 text-xs text-accent">{chosen ? "Добавлено" : "Добавить"}</span></button></li>;
            })}</ul> : <p className="py-2 text-xs text-muted">Нет подключённых приложений, доступных для этого сеанса.</p>}
        {!appPickerLoading && !appPickerError && availableApps.some((app) => !app.callable || !app.accessible || !app.enabled) && <p className="mt-2 text-[10px] leading-4 text-muted">Недоступные приложения можно подключить в настройках Codex на компьютере.</p>}
      </section>}
      {images.length > 0 && <div className="mx-auto mb-2 flex max-w-4xl gap-2 overflow-x-auto">{images.map((image, index) => <div key={`${image.name}-${index}`} className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border border-border"><img src={image.preview} alt={image.name} className="h-full w-full object-cover" /><button type="button" aria-label={`Убрать ${image.name}`} className="absolute right-1 top-1 rounded-full bg-black/75 px-1.5 text-xs" onClick={() => setImages((current) => current.filter((_, i) => i !== index))}>×</button></div>)}</div>}
      {attachments.length > 0 && <ul className="mx-auto mb-2 flex max-w-4xl flex-wrap gap-2" aria-label="Прикреплённые файлы">{attachments.map((file) => <li key={file.id} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs"><FileText size={14} className="shrink-0 text-accent" /><span className="max-w-[min(64vw,20rem)] truncate" title={file.name}>{file.name}</span><span className="shrink-0 text-[10px] text-muted">{(file.size / 1024).toFixed(file.size < 10_240 ? 1 : 0)} КБ</span><button type="button" className="min-h-7 min-w-7 rounded-md text-muted hover:bg-elevated" aria-label={`Убрать файл ${file.name}`} disabled={uploadingAttachments} onClick={() => void removeDocument(file.id)}><X size={13} /></button></li>)}</ul>}
      {selectedAppIds.length > 0 && <ul className="mx-auto mb-2 flex max-w-4xl flex-wrap gap-2" aria-label="Выбранные приложения">{selectedAppIds.map((id) => {
        const app = availableApps.find((candidate) => candidate.id === id);
        const name = app?.name ?? id;
        return <li key={id} className="flex min-w-0 items-center gap-1 rounded-lg border border-[#46533d] bg-[#20291b] px-2 py-1 text-xs text-[#d5f49c]"><Plug size={12} className="shrink-0" /><span className="max-w-[min(48vw,14rem)] truncate">{name}</span><button type="button" className="min-h-7 min-w-7 rounded-md text-muted hover:bg-elevated" aria-label={`Убрать приложение ${name}`} onClick={() => toggleSelectedApp(id)}><X size={13} /></button></li>;
      })}</ul>}
      <div className="mx-auto mb-2 flex max-w-4xl items-center gap-2">
        <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label="Выбрать навык Codex" disabled={!connected} onClick={() => void toggleSkillPicker()}><Sparkles size={15} />Навыки</Button>
        <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" aria-label="Выбрать приложение Codex" disabled={!connected} onClick={() => void toggleAppPicker()}><Plug size={15} />Приложения</Button>
      </div>
      <div className="mx-auto flex max-w-4xl items-end gap-2">
        <label className="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-border bg-[#1b211c] text-muted hover:text-accent" aria-label="Прикрепить фото">
          <ImagePlus size={19} />
          <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" multiple disabled={preparing || images.length >= 3} onChange={(event) => { void attach(event.target.files); event.target.value = ""; }} />
        </label>
        <label className={`flex min-h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-[#1b211c] text-muted ${connected && attachments.length < 5 && !uploadingAttachments ? "cursor-pointer hover:text-accent" : "cursor-not-allowed opacity-45"}`} aria-label="Прикрепить файл">
          {uploadingAttachments ? <LoaderCircle size={18} className="animate-spin" /> : <Paperclip size={18} />}
          <span className="sr-only">Прикрепить текстовый файл, PDF или ZIP</span>
          <input type="file" className="sr-only" accept=".txt,.md,.markdown,.json,.json5,.jsonl,.csv,.tsv,.log,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.ts,.tsx,.js,.jsx,.mjs,.py,.go,.rs,.java,.kt,.html,.css,.sql,.sh,.ps1,.patch,.diff,.pdf,.zip,text/*,application/pdf,application/zip" multiple disabled={!connected || attachments.length >= 5 || uploadingAttachments} onChange={(event) => { void attachDocuments(event.target.files); event.target.value = ""; }} />
        </label>
        <div className="min-w-0 flex-1"><Textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={submitOnEnter} placeholder={!connected ? "Подключите сеанс, чтобы отправить задачу" : turnBusy && followUpMode === "steer" ? "Направление для текущей задачи…" : turnBusy ? "Следующая задача в очереди…" : "Задача для Codex…"} disabled={!connected} rows={2} className="min-h-[48px] max-h-40 resize-none py-3" aria-label="Сообщение Codex" /></div>
        <Button type="submit" className="min-h-12 w-12 shrink-0 px-0" disabled={!connected || (!text.trim() && images.length === 0 && attachments.length === 0) || preparing || uploadingAttachments || (followUpMode === "steer" && turnBusy && attachments.length > 0)} aria-label={followUpMode === "steer" && turnBusy ? "Направить текущую задачу" : "Отправить задачу"}>{preparing || uploadingAttachments ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}</Button>
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
    {editOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/75 p-3 sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !editSaving) setEditOpen(false); }}>
      <section className="my-auto w-full max-w-lg rounded-2xl border border-border bg-panel p-4 shadow-soft sm:p-5" role="dialog" aria-modal="true" aria-labelledby="edit-turn-title" aria-describedby="edit-turn-description">
        <h2 id="edit-turn-title" className="text-base font-semibold">Редактировать запрос из истории</h2>
        <p id="edit-turn-description" className="mt-2 text-sm leading-6 text-muted">При подтверждении Codex удалит выбранный ход и все более поздние ходы из истории, затем отправит новый запрос. Изменения файлов, команды и внешние действия не отменяются.</p>
        {editLoading ? <p className="mt-4 flex items-center gap-2 py-4 text-sm text-muted" role="status"><LoaderCircle size={16} className="animate-spin" /> Загружаю запрос…</p>
          : editTurn?.editable && editTurn.turnId ? <>
            {editTurns.length > 1 && <label className="mt-3 block space-y-1.5"><span className="text-xs font-medium text-muted">Выберите запрос</span><select aria-label="Запрос для редактирования" className="min-h-11 w-full rounded-xl border border-border bg-[#111613] px-3 text-sm text-text" value={editTurn.turnId} disabled={editSaving} onChange={(event) => {
              const selected = editTurns.find((turn) => turn.turnId === event.target.value);
              if (selected) { setEditTurn(selected); setEditText(selected.text); setEditError(""); }
            }}>{editTurns.map((turn, index) => {
              const snippet = turn.text.replace(/\s+/g, " ").trim().slice(0, 72) || "Запрос без текста";
              const label = `${index === 0 ? "Последний" : `${index + 1}-й с конца`} · ${snippet}`;
              return <option key={turn.turnId} value={turn.turnId} disabled={!turn.editable}>{label}{turn.editable ? "" : " · нельзя редактировать"}</option>;
            })}</select></label>}
            {editTurn.skillNames?.length ? <p className="mt-3 text-xs text-muted">Сохранятся навыки: {editTurn.skillNames.join(", ")}</p> : null}
            {editTurn.appIds?.length ? <p className="mt-3 text-xs text-muted">Сохранятся подключённые приложения: {editTurn.appIds.length}.</p> : null}
            {(editTurn.attachmentCount ?? 0) > 0 && <p className="mt-3 text-xs text-muted">Исходные вложения сохранятся: {editTurn.attachmentCount}.</p>}
            <label htmlFor="edit-turn-text" className="mt-3 block text-xs font-medium text-muted">Текст запроса</label>
            <Textarea id="edit-turn-text" value={editText} onChange={(event) => setEditText(event.target.value)} rows={6} maxLength={16000} className="mt-1 max-h-[35svh] resize-y" aria-label="Новый текст запроса" />
            <p className="mt-1 text-right text-[11px] text-muted">{editText.length}/16000</p>
          </> : <div className="mt-4 rounded-xl border border-border bg-[#111613] p-3 text-sm text-muted">
            <p className="font-medium text-text">Нет запроса, который можно безопасно редактировать</p>
            {editTurn?.reason && <p className="mt-1">{editTurn.reason}</p>}
            {(editTurn?.attachmentCount ?? 0) > 0 && <p className="mt-1">Вложения: {editTurn?.attachmentCount}. Чтобы не потерять их, отправьте новый запрос отдельно.</p>}
            {!editTurn?.reason && !(editTurn?.attachmentCount ?? 0) && <p className="mt-1">Codex не нашёл недавний текстовый запрос без вложений.</p>}
          </div>}
        <p className="mt-3 rounded-xl border border-[#5f4d2d] bg-[#292316] p-3 text-xs leading-5 text-[#f0d995]">Редактирование меняет историю сеанса. Оно не возвращает файлы к прежнему состоянию и не отменяет уже выполненные команды.</p>
        {editError && <p className="mt-3 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]" role="alert">{editError}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" disabled={editSaving} onClick={() => setEditOpen(false)}>Отмена</Button>
          <Button type="button" disabled={editLoading || editSaving || !editTurn?.editable || !editTurn.turnId || !editText.trim()} onClick={() => void submitEdit()}>
            {editSaving ? <LoaderCircle size={15} className="animate-spin" /> : <Pencil size={15} />}{editSaving ? "Отправляю…" : "Заменить и отправить"}
          </Button>
        </div>
      </section>
    </div>}
    {compactConfirm && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !compacting) setCompactConfirm(false); }}>
      <section className="w-full max-w-md rounded-2xl border border-border bg-panel p-5 shadow-soft" role="dialog" aria-modal="true" aria-labelledby="compact-title" aria-describedby="compact-description">
        <h2 id="compact-title" className="text-base font-semibold">Сократить контекст сеанса?</h2>
        <p id="compact-description" className="mt-2 text-sm leading-6 text-muted">Codex подготовит краткое изложение старой части истории, чтобы освободить место для дальнейшей работы. Это действие изменит контекст сеанса.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={compacting} onClick={() => setCompactConfirm(false)}>Отмена</Button>
          <Button type="button" disabled={compacting || compactAwaitingConfirmation || turnBusy} onClick={() => {
            setCompactNotice("");
            compactConfirmationSeen.current = false;
            compactEventStart.current = events.filter((event) => event.sessionId === session?.id).reduce((latest, event) => Math.max(latest, event.id), 0);
            setCompactAwaitingConfirmation(true);
            void onCompact().then(() => {
              setCompactConfirm(false);
              if (!compactConfirmationSeen.current) setCompactNotice("Запрос принят Codex. Ожидается подтверждение завершения.");
            }).catch(() => {
              setCompactAwaitingConfirmation(false);
              setCompactConfirm(false);
              setCompactNotice("Codex не подтвердил принятие запроса.");
            });
          }}>
            {compacting ? <LoaderCircle size={15} className="animate-spin" /> : <Minimize2 size={15} />}Сократить контекст
          </Button>
        </div>
      </section>
    </div>}
  </main>;
}
