import { useMemo, useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Check, FolderKanban, FolderPlus, LoaderCircle, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import type { MobileSession, MobileSnapshot, MobileThreadSection } from "../types.js";
import { Button, Input } from "./ui/primitives.js";

export function Workspace({
  snapshot, selectedProject, search, searchResults, searchCursor, searchLoading, searchMoreLoading, extraSessions,
  sessionsMoreLoading, sessionsHasMore, onLoadMoreSessions,
  showArchived, selectedId, open, connectedIds,
  onProjectChange, onSearchChange, onArchivedChange, onLoadMore, onSelect, onCreate, onClose, onArchive, onUnarchive, onRename, onDelete,
  onCreateSection, onRenameSection, onDeleteSection, onMoveSession,
}: {
  snapshot: MobileSnapshot;
  selectedProject: string;
  search: string;
  searchResults?: MobileSession[];
  searchCursor: string;
  searchLoading: boolean;
  searchMoreLoading: boolean;
  extraSessions: MobileSession[];
  sessionsMoreLoading: boolean;
  sessionsHasMore: boolean;
  onLoadMoreSessions: () => void;
  showArchived: boolean;
  selectedId: string;
  open: boolean;
  connectedIds: Set<string>;
  onProjectChange: (path: string) => void;
  onSearchChange: (value: string) => void;
  onArchivedChange: (archived: boolean) => void;
  onLoadMore: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onClose: () => void;
  onArchive: (sessionId: string) => Promise<void>;
  onUnarchive: (sessionId: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  onCreateSection: (name: string) => Promise<void>;
  onRenameSection: (sectionId: string, name: string) => Promise<void>;
  onDeleteSection: (sectionId: string) => Promise<void>;
  onMoveSession: (sessionId: string, sectionId: string | null) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<MobileSession>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [editingSectionId, setEditingSectionId] = useState("");
  const [editingSectionName, setEditingSectionName] = useState("");
  const [savingSection, setSavingSection] = useState(false);
  const [deleteSectionCandidate, setDeleteSectionCandidate] = useState<MobileThreadSection>();
  const [sectionError, setSectionError] = useState("");
  const nativeSearch = search.trim().length >= 2;
  const sectionsAvailable = snapshot.sectionsAvailable !== false;
  const sessions = useMemo(() => {
    const source = nativeSearch ? searchResults ?? [] : [...(showArchived ? snapshot.archivedSessions ?? [] : snapshot.sessions), ...extraSessions];
    const known = new Set<string>();
    return source.filter((session) => {
      if (known.has(session.id)) return false;
      known.add(session.id);
      return (!selectedProject || session.cwd === selectedProject) &&
        (!sectionFilter || (sectionFilter === "__unsectioned__" ? !session.section?.id : session.section?.id === sectionFilter)) &&
        (nativeSearch || !search || `${session.title} ${session.cwd}`.toLowerCase().includes(search.toLowerCase()));
    });
  }, [snapshot.sessions, snapshot.archivedSessions, searchResults, extraSessions, selectedProject, search, showArchived, nativeSearch, sectionFilter]);
  const currentProject = snapshot.projects.find((project) => project.path === selectedProject);

  async function saveRename(session: MobileSession) {
    if (!renameValue.trim() || savingName) return;
    setSavingName(true);
    try {
      await onRename(session.id, renameValue.trim());
      setEditingId("");
    } catch { /* The app-level alert keeps the name available for retry. */ }
    finally { setSavingName(false); }
  }

  async function confirmDelete() {
    if (!deleteCandidate || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await onDelete(deleteCandidate.id);
      setDeleteCandidate(undefined);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Codex не удалил этот сеанс");
    }
    finally { setDeleting(false); }
  }

  async function saveNewSection(event: FormEvent) {
    event.preventDefault();
    const name = newSectionName.trim();
    if (!name || savingSection) return;
    setSavingSection(true); setSectionError("");
    try { await onCreateSection(name); setNewSectionName(""); }
    catch (cause) { setSectionError(cause instanceof Error ? cause.message : "Не удалось создать раздел"); }
    finally { setSavingSection(false); }
  }

  async function saveSectionName(sectionId: string) {
    const name = editingSectionName.trim();
    if (!name || savingSection) return;
    setSavingSection(true); setSectionError("");
    try { await onRenameSection(sectionId, name); setEditingSectionId(""); }
    catch (cause) { setSectionError(cause instanceof Error ? cause.message : "Не удалось переименовать раздел"); }
    finally { setSavingSection(false); }
  }

  async function confirmDeleteSection() {
    if (!deleteSectionCandidate || savingSection) return;
    setSavingSection(true); setSectionError("");
    try { await onDeleteSection(deleteSectionCandidate.id); setDeleteSectionCandidate(undefined); }
    catch (cause) { setSectionError(cause instanceof Error ? cause.message : "Не удалось удалить раздел"); }
    finally { setSavingSection(false); }
  }

  return <>
    {open && <button className="fixed inset-0 z-30 bg-black/55 md:hidden" aria-label="Закрыть список сеансов" onClick={onClose} />}
    <aside className={`${open ? "fixed inset-x-0 bottom-0 top-[68px] z-40 flex" : "hidden"} w-full shrink-0 flex-col border-r border-border bg-[#141815] md:relative md:inset-auto md:z-auto md:flex md:w-[292px]`}>
      <div className="flex items-center justify-between border-b border-border px-4 py-4">
        <div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#a7c278]">Рабочее место</p><h2 className="mt-1 truncate text-sm font-semibold">{currentProject?.name ?? "Все проекты"}</h2></div>
        <Button variant="ghost" className="min-h-10 px-2 md:hidden" aria-label="Закрыть список" onClick={onClose}><X size={18} /></Button>
      </div>

      <div className="space-y-3 p-4">
        <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><FolderKanban size={15} /> Проект</label>
        <select value={selectedProject} onChange={(event) => onProjectChange(event.target.value)} className="min-h-11 w-full rounded-xl border border-border bg-[#111613] px-3 text-sm text-text outline-none focus:border-accent">
          <option value="">Все проекты</option>
          {snapshot.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
        </select>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-3.5 text-[#7e897f]" size={15} />
          <Input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Найти сеанс" className="pl-9" aria-label="Найти сеанс" />
        </label>
        <div className="flex gap-2">
          <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} aria-label="Фильтр разделов" disabled={!sectionsAvailable} className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-[#111613] px-3 text-sm text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-55">
            <option value="">Все разделы</option>
            <option value="__unsectioned__">Без раздела</option>
            {(snapshot.sections ?? []).map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
          </select>
          <Button type="button" variant="outline" className="min-h-11 shrink-0 px-3" aria-label="Управление разделами" disabled={!sectionsAvailable} onClick={() => { setSectionError(""); setSectionsOpen(true); }}><FolderPlus size={16} />Разделы</Button>
        </div>
        {!sectionsAvailable && <p role="status" className="text-xs leading-5 text-muted">Эта версия Codex не предоставляет API разделов сеансов.</p>}
        <Button className="w-full" onClick={onCreate} disabled={!selectedProject}><Plus size={16} /> Новый сеанс</Button>
        {!selectedProject && <p className="text-xs text-muted">Выберите проект, чтобы создать сеанс.</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {sectionError && !sectionsOpen && <p role="alert" className="mb-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-xs text-[#ffc3bd]">{sectionError}</p>}
        <div className="mb-2 flex items-center justify-between gap-2 px-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#849084]">
          <span>{showArchived ? "Архив" : "Сеансы"} · {sessions.length}</span>
          <button type="button" aria-pressed={showArchived} disabled={!snapshot.archiveAvailable} onClick={() => { onArchivedChange(!showArchived); setEditingId(""); }} className="min-h-9 rounded-lg px-2 text-[11px] font-semibold normal-case tracking-normal text-accent disabled:cursor-not-allowed disabled:text-muted">
            {snapshot.archiveAvailable ? showArchived ? "Активные" : "Архив" : "Архив недоступен"}
          </button>
        </div>
        {showArchived && !snapshot.archiveAvailable && <p className="px-2 pb-2 text-xs text-muted">Codex не подтвердил доступность архива.</p>}
        <div className="space-y-1">
          {sessions.map((session) => {
            const active = session.id === selectedId;
            const connected = connectedIds.has(session.id);
            const pinnedSection = snapshot.sections?.find((section) => section.builtIn);
            const pinned = Boolean(pinnedSection && session.section?.id === pinnedSection.id);
            return <div key={session.id} className={`rounded-xl border p-2 ${active ? "border-[#596b43] bg-[#222a1e]" : "border-transparent hover:border-border hover:bg-elevated"}`}>
              <button type="button" onClick={() => { onSelect(session.id); onClose(); }} className="w-full rounded-lg px-1 py-1 text-left">
                <span className="flex items-start justify-between gap-3">
                  <span className={`min-w-0 truncate text-sm font-medium ${active ? "text-text" : "text-[#c4cdc3]"}`}>{session.title || "Новый сеанс"}</span>
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${session.archived ? "bg-[#59625a]" : session.busy ? "animate-pulse bg-[#d8f58e]" : connected ? "bg-[#76984c]" : "bg-[#59625a]"}`} aria-label={session.archived ? "В архиве" : session.busy ? "Выполняется" : connected ? "Подключён" : "Статус неизвестен"} />
                </span>
                <span className="mt-2 block truncate text-xs text-[#839087]">{session.archived ? "В архиве" : session.liveLabel || "Статус неизвестен"}</span>
                {session.section?.name && <span className="mt-1 inline-flex max-w-full truncate rounded-md border border-[#3b4832] bg-[#1c2418] px-2 py-0.5 text-[10px] text-[#bedb92]">{session.section.name}</span>}
                <span className="mt-1 block truncate font-mono text-[10px] text-[#657066]">{session.cwd}</span>
              </button>
              {editingId === session.id ? <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); void saveRename(session); }}>
                <Input aria-label={`Новое название ${session.title}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={120} autoFocus />
                <Button type="submit" variant="outline" className="min-h-10 px-2" aria-label="Сохранить название" disabled={!renameValue.trim() || savingName}><Check size={16} /></Button>
                <Button type="button" variant="ghost" className="min-h-10 px-2" aria-label="Отменить переименование" onClick={() => setEditingId("")}><X size={16} /></Button>
              </form> : showArchived ? <div className="mt-2 space-y-1">
                <Button type="button" variant="ghost" className="min-h-9 w-full px-2 text-[11px]" onClick={() => { setEditingId(session.id); setRenameValue(session.title); }}><Pencil size={13} /> Переименовать</Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="min-h-9 flex-1 px-2 text-[11px]" onClick={() => void onUnarchive(session.id)}><ArchiveRestore size={13} /> Восстановить</Button>
                  <Button type="button" variant="danger" className="min-h-9 flex-1 px-2 text-[11px]" aria-label={`Удалить навсегда: ${session.title || "Новый сеанс"}`} onClick={() => { setDeleteError(""); setDeleteCandidate(session); }}><Trash2 size={13} /> Удалить</Button>
                </div>
              </div> : <div className="mt-2 space-y-1">
                <select aria-label={`Раздел сеанса ${session.title || "Новый сеанс"}`} value={session.section?.id ?? ""} onChange={(event) => void onMoveSession(session.id, event.target.value || null).catch((cause) => setSectionError(cause instanceof Error ? cause.message : "Не удалось переместить сеанс"))} disabled={!sectionsAvailable} className="min-h-9 w-full rounded-lg border border-border bg-[#111613] px-2 text-xs text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-55">
                  <option value="">Без раздела</option>
                  {(snapshot.sections ?? []).map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
                </select>
                <div className="flex flex-wrap gap-1">
                  <Button type="button" variant={pinned ? "outline" : "ghost"} className="min-h-9 flex-1 px-2 text-[11px]" aria-label={pinned ? `Открепить сеанс ${session.title}` : `Закрепить сеанс ${session.title}`} disabled={!sectionsAvailable || !pinnedSection} onClick={() => void onMoveSession(session.id, pinned ? null : pinnedSection?.id ?? null).catch((cause) => setSectionError(cause instanceof Error ? cause.message : "Не удалось изменить закрепление сеанса"))}>{pinned ? <PinOff size={13} /> : <Pin size={13} />}{pinned ? "Открепить" : "Закрепить"}</Button>
                  <Button type="button" variant="ghost" className="min-h-9 flex-1 px-2 text-[11px]" onClick={() => { setEditingId(session.id); setRenameValue(session.title); }}><Pencil size={13} /> Переименовать</Button>
                  <Button type="button" variant="outline" className="min-h-9 flex-1 px-2 text-[11px]" disabled={session.busy || !snapshot.archiveAvailable} onClick={() => void onArchive(session.id)}><Archive size={13} /> В архив</Button>
                </div>
              </div>}
            </div>;
          })}
          {sessions.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs leading-5 text-muted">{nativeSearch && (searchLoading || searchResults === undefined) ? "Ищу сеансы в Codex…" : showArchived ? "В архиве нет сеансов." : "Сеансы не найдены. Проверьте фильтр или обновите список."}</p>}
          {nativeSearch && searchCursor && <Button type="button" variant="outline" className="mt-2 w-full" onClick={onLoadMore} disabled={searchLoading || searchMoreLoading}>{searchMoreLoading ? "Загружаю…" : "Ещё результаты"}</Button>}
          {!nativeSearch && sessionsHasMore && <Button type="button" variant="outline" className="mt-2 w-full" onClick={onLoadMoreSessions} disabled={sessionsMoreLoading}>{sessionsMoreLoading ? "Загружаю сеансы…" : "Ещё сеансы"}</Button>}
        </div>
      </div>
      <div className="border-t border-border px-4 py-3 text-[11px] text-[#788278]">Codex Desktop · история и управление</div>
    </aside>
    {sectionsOpen && <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="thread-sections-title" className="safe-area-bottom max-h-[90svh] w-full max-w-lg space-y-4 overflow-y-auto rounded-2xl border border-border bg-elevated p-5 shadow-soft">
        <div className="flex items-start justify-between gap-3"><div><h3 id="thread-sections-title" className="text-base font-semibold">Разделы сеансов</h3><p className="mt-1 text-xs leading-5 text-muted">Изменения сохраняются через Codex и появятся в его списке сеансов.</p></div><Button type="button" variant="ghost" className="min-h-9 px-2" aria-label="Закрыть управление разделами" onClick={() => setSectionsOpen(false)}><X size={17} /></Button></div>
        {sectionError && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]">{sectionError}</p>}
        <form className="flex gap-2" onSubmit={(event) => void saveNewSection(event)}><Input aria-label="Название нового раздела" value={newSectionName} onChange={(event) => setNewSectionName(event.target.value)} maxLength={64} placeholder="Например, На проверку" /><Button type="submit" className="shrink-0 px-3" disabled={!newSectionName.trim() || savingSection}>{savingSection ? <LoaderCircle size={15} className="animate-spin" /> : <Plus size={16} />}Создать</Button></form>
        <div className="space-y-2">
          {(snapshot.sections ?? []).filter((section) => !section.builtIn).map((section) => <div key={section.id} className="rounded-xl border border-border bg-panel p-3">
            {editingSectionId === section.id ? <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void saveSectionName(section.id); }}><Input aria-label={`Новое название раздела ${section.name}`} value={editingSectionName} onChange={(event) => setEditingSectionName(event.target.value)} maxLength={64} /><Button type="submit" variant="outline" className="min-h-10 px-2" aria-label="Сохранить раздел" disabled={!editingSectionName.trim() || savingSection}><Check size={16} /></Button><Button type="button" variant="ghost" className="min-h-10 px-2" aria-label="Отменить переименование раздела" onClick={() => setEditingSectionId("")}><X size={16} /></Button></form> : <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-sm font-medium">{section.name}</span><span className="flex shrink-0 gap-1"><Button type="button" variant="ghost" className="min-h-9 px-2" aria-label={`Переименовать раздел ${section.name}`} onClick={() => { setEditingSectionId(section.id); setEditingSectionName(section.name); setSectionError(""); }}><Pencil size={14} /></Button><Button type="button" variant="danger" className="min-h-9 px-2" aria-label={`Удалить раздел ${section.name}`} onClick={() => { setSectionError(""); setDeleteSectionCandidate(section); }}><Trash2 size={14} /></Button></span></div>}
          </div>)}
          {(snapshot.sections ?? []).length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-sm text-muted">Пользовательских разделов пока нет.</p>}
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={() => setSectionsOpen(false)}>Готово</Button>
      </section>
    </div>}
    {deleteSectionCandidate && <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/80 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="delete-section-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-[#733b39] bg-elevated p-5 shadow-soft">
        <div><h3 id="delete-section-title" className="flex items-center gap-2 text-base font-semibold"><Trash2 size={17} className="text-[#ffc3bd]" />Удалить раздел?</h3><p className="mt-2 break-words text-sm font-medium">{deleteSectionCandidate.name}</p><p className="mt-2 text-sm leading-relaxed text-muted">Codex удалит только этот раздел. Сеансы, их история и файлы проекта останутся на месте.</p></div>
        {sectionError && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]">{sectionError}</p>}
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={savingSection} onClick={() => setDeleteSectionCandidate(undefined)}>Отмена</Button><Button type="button" variant="danger" className="flex-1" disabled={savingSection} onClick={() => void confirmDeleteSection()}>{savingSection ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}Удалить раздел</Button></div>
      </section>
    </div>}
    {deleteCandidate && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title" className="safe-area-bottom w-full max-w-md space-y-4 rounded-2xl border border-[#733b39] bg-elevated p-5 shadow-soft">
        <div><h3 id="delete-session-title" className="flex items-center gap-2 text-base font-semibold"><Trash2 size={17} className="text-[#ffc3bd]" />Удалить сеанс навсегда?</h3>
          <p className="mt-2 break-words text-sm font-medium text-text">{deleteCandidate.title || "Новый сеанс"}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">Codex удалит этот архивный сеанс вместе с историей. Это действие нельзя отменить. Файлы проекта не меняются; если Codex не может удалить сеанс, он останется в архиве.</p>
        </div>
        {deleteError && <p role="alert" className="rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]">{deleteError}</p>}
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" disabled={deleting} onClick={() => { setDeleteCandidate(undefined); setDeleteError(""); }}>Отмена</Button>
          <Button type="button" variant="danger" className="flex-1" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}Удалить навсегда</Button></div>
      </section>
    </div>}
  </>;
}
