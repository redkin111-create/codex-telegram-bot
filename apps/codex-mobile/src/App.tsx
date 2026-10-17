import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, GitBranch, LoaderCircle, Menu, RefreshCw, Shield, ShieldAlert, SlidersHorizontal } from "lucide-react";
import {
  asLiveEvent, logout, MobileApiError, openEventStream, parseSseBlock, readActivity, readApprovals,
  readHistory, readSession, readSnapshot, resolveApproval, runOperation,
} from "./api.js";
import { ApprovalPanel } from "./components/approval-panel.js";
import { Conversation, type FollowUpMode, type PromptImage } from "./components/conversation.js";
import { DevicePanel } from "./components/device-panel.js";
import { FilesPanel } from "./components/files-panel.js";
import { GitPanel } from "./components/git-panel.js";
import { Pairing } from "./components/pairing.js";
import { SettingsPanel } from "./components/settings-panel.js";
import { Workspace } from "./components/workspace.js";
import type {
  HistoryEntry, MobileActivity, MobileApproval, MobileDevice, MobileLiveEvent, MobileQueue, MobileSnapshot,
  MobileOperation,
} from "./types.js";
import { Button } from "./components/ui/primitives.js";

const emptyQueue: MobileQueue = { items: [], busy: false, paused: false };

export default function App() {
  const [device, setDevice] = useState<MobileDevice>();
  const [csrf, setCsrf] = useState("");
  const [snapshot, setSnapshot] = useState<MobileSnapshot>();
  const [selectedId, setSelectedId] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activity, setActivity] = useState<MobileActivity>();
  const [queue, setQueue] = useState<MobileQueue>(emptyQueue);
  const [events, setEvents] = useState<MobileLiveEvent[]>([]);
  const [includeTools, setIncludeTools] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [forking, setForking] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<MobileApproval>();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const eventCursor = useRef(0);
  const eventEpoch = useRef("");
  const eventSession = useRef("");
  const pendingSend = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);

  const expireSession = useCallback(() => {
    setDevice(undefined);
    setCsrf("");
    setSnapshot(undefined);
    setSelectedId("");
    setHistory([]);
    setActivity(undefined);
    setQueue(emptyQueue);
    setEvents([]);
    setDevicesOpen(false);
    setSettingsOpen(false);
    setFilesOpen(false);
    setGitOpen(false);
    setPendingApproval(undefined);
    setApprovalOpen(false);
  }, []);

  const handleApiError = useCallback((cause: unknown) => {
    if (cause instanceof MobileApiError && cause.status === 401) {
      expireSession();
      return;
    }
    setError(cause instanceof Error ? cause.message : "Не удалось связаться с Codex");
  }, [expireSession]);

  const refreshSnapshot = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const next = await readSnapshot();
      setSnapshot(next);
      setSelectedProject((current) => current || next.projects[0]?.path || "");
      setSelectedId((current) => current || next.selected || "");
      setError("");
    } catch (cause) { handleApiError(cause); }
    finally { if (showSpinner) setRefreshing(false); }
  }, [handleApiError]);

  useEffect(() => {
    let alive = true;
    void readSession().then((value) => {
      if (!alive) return;
      setDevice(value.device);
      setCsrf(value.csrfToken);
    }).catch((cause: unknown) => {
      if (alive && !(cause instanceof MobileApiError && cause.status === 401)) handleApiError(cause);
    });
    return () => { alive = false; };
  }, [handleApiError]);

  useEffect(() => {
    if (!device) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => { void refreshSnapshot(); }, 5000);
    return () => window.clearInterval(timer);
  }, [device, refreshSnapshot]);

  const selectedSession = useMemo(
    () => snapshot?.sessions.find((session) => session.id === selectedId) ?? snapshot?.archivedSessions?.find((session) => session.id === selectedId),
    [snapshot?.sessions, snapshot?.archivedSessions, selectedId],
  );
  const connectedIds = useMemo(
    () => new Set(snapshot?.controlled.map((session) => session.id) ?? []),
    [snapshot?.controlled],
  );
  const connected = !selectedSession?.archived && connectedIds.has(selectedId);

  useEffect(() => {
    if (!device || !selectedId) {
      setHistory([]);
      setActivity(undefined);
      setQueue(emptyQueue);
      setPendingApproval(undefined);
      setApprovalOpen(false);
      return;
    }
    setPendingApproval(undefined);
    void readApprovals(selectedId).then(({ approvals }) => {
      const current = approvals[0];
      setPendingApproval(current);
      if (current) setApprovalOpen(true);
    }).catch(handleApiError);
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const result = await readHistory(selectedId, includeTools);
        if (alive) setHistory(result.entries);
      } catch (cause) { if (alive) handleApiError(cause); }
      finally { if (alive) setLoading(false); }
      try {
        const nextActivity = await readActivity(selectedId);
        if (alive) setActivity(nextActivity);
      } catch (cause) { if (alive) handleApiError(cause); }
      if (connected) {
        try {
          const nextQueue = await runOperation<MobileQueue>("queue", { sessionId: selectedId }, csrf);
          if (alive) setQueue(nextQueue);
        } catch (cause) { if (alive) handleApiError(cause); }
      } else setQueue(emptyQueue);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [device, selectedId, includeTools, connected, csrf, handleApiError]);

  useEffect(() => {
    if (!device || !csrf || !selectedId) { setStreamConnected(false); return; }
    let stopped = false;
    let controller: AbortController | undefined;
    if (eventSession.current !== selectedId) {
      eventSession.current = selectedId;
      eventCursor.current = 0;
      eventEpoch.current = "";
    }
    const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const connect = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const reader = await openEventStream(selectedId, eventCursor.current, eventEpoch.current, csrf, controller.signal);
          setStreamConnected(true);
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const message = parseSseBlock(block);
              if (!message) continue;
              if (message.event === "hello") {
                try {
                  const hello = JSON.parse(message.data) as { epoch?: unknown };
                  if (typeof hello.epoch === "string") eventEpoch.current = hello.epoch;
                } catch { /* Ignore malformed stream control data. */ }
              } else if (message.event === "revoked") {
                expireSession();
                return;
              } else {
                const event = asLiveEvent(message);
                if (event) {
                  eventCursor.current = Math.max(eventCursor.current, event.id);
                  setEvents((current) => [...current.slice(-29), event]);
                  if (event.kind === "status" || event.kind === "activity") {
                    void readActivity(selectedId).then(setActivity).catch(handleApiError);
                  }
                  if (event.kind === "approval" && event.approval) {
                    setPendingApproval(event.approval);
                    setApprovalOpen(true);
                  } else if (event.kind === "status") {
                    void readApprovals(selectedId).then(({ approvals }) => {
                      const current = approvals[0];
                      setPendingApproval(current);
                      if (current) setApprovalOpen(true);
                      else setApprovalOpen(false);
                    }).catch(handleApiError);
                  }
                }
              }
            }
          }
        } catch (cause) {
          if (!stopped && cause instanceof MobileApiError && cause.status === 401) {
            expireSession();
            return;
          }
        } finally {
          setStreamConnected(false);
          controller?.abort();
        }
        if (!stopped) await delay(1200);
      }
    };
    void connect();
    return () => { stopped = true; controller?.abort(); };
  }, [device, csrf, selectedId, expireSession, handleApiError]);

  const operation = useCallback(async <T,>(op: Parameters<typeof runOperation<T>>[0], args: Record<string, unknown>) => {
    setError("");
    try {
      const result = await runOperation<T>(op, args, csrf);
      void refreshSnapshot();
      return result;
    } catch (cause) { handleApiError(cause); throw cause; }
  }, [csrf, handleApiError, refreshSnapshot]);

  async function connectSession() {
    if (!selectedId) return;
    setConnecting(true);
    try {
      if (selectedSession?.archived) {
        await operation("unarchiveThread", { sessionId: selectedId });
        await refreshSnapshot();
        return;
      }
      await operation("select", { sessionId: selectedId });
      await refreshSnapshot();
    } catch { /* The error is shown in the conversation panel. */ }
    finally { setConnecting(false); }
  }

  async function createSession() {
    if (!selectedProject) return;
    try {
      const created = await operation<{ sessionId: string }>("create", { cwd: selectedProject });
      setSelectedId(created.sessionId);
      setWorkspaceOpen(false);
      await refreshSnapshot();
    } catch { /* The error is shown in the conversation panel. */ }
  }

  async function forkSession() {
    if (!selectedId || forking) return;
    setForking(true);
    try {
      const fork = await operation<{ sessionId: string }>("forkThread", { sessionId: selectedId });
      await operation("select", { sessionId: fork.sessionId });
      setSelectedId(fork.sessionId);
      setWorkspaceOpen(false);
      await refreshSnapshot();
    } catch { /* Keep the source session selected and show the error. */ }
    finally { setForking(false); }
  }

  async function compactSession() {
    if (!selectedId || compacting) return;
    setCompacting(true);
    try {
      await operation("compactThread", { sessionId: selectedId });
    } finally { setCompacting(false); }
  }

  async function archiveSession(sessionId: string) {
    try {
      await operation("archiveThread", { sessionId });
      await refreshSnapshot();
    } catch { /* The app-level alert reports the archive error. */ }
  }

  async function unarchiveSession(sessionId: string) {
    try {
      await operation("unarchiveThread", { sessionId });
      await refreshSnapshot();
    } catch { /* The app-level alert reports the restore error. */ }
  }

  async function renameSession(sessionId: string, name: string) {
    await operation("renameThread", { sessionId, name });
    await refreshSnapshot();
  }

  async function send(text: string, images: PromptImage[], mode: FollowUpMode) {
    if (!selectedId) return;
    const fingerprint = JSON.stringify([selectedId, mode, text, images.map((image) => [image.name, image.mimeType, image.data.length])]);
    if (!pendingSend.current || pendingSend.current.fingerprint !== fingerprint) {
      pendingSend.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    if (mode === "steer") {
      await operation("steer", {
        sessionId: selectedId, text, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        requestId: pendingSend.current.requestId,
      });
    } else {
      await operation("send", {
        sessionId: selectedId, text, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        requestId: pendingSend.current.requestId,
      });
    }
    pendingSend.current = undefined;
    setTimeout(() => { void refreshSnapshot(); }, 500);
  }

  async function cancel() {
    if (!selectedId) return;
    await operation("cancel", { sessionId: selectedId }).catch(() => undefined);
    await readQueue();
  }

  async function readQueue() {
    if (!selectedId || !connected) return;
    try { setQueue(await operation<MobileQueue>("queue", { sessionId: selectedId })); }
    catch { /* Keep the last queue state visible. */ }
  }

  async function removeQueued(itemId: string) {
    if (!selectedId) return;
    await operation("queueRemove", { sessionId: selectedId, itemId }).catch(() => undefined);
    await readQueue();
  }

  async function resumeQueue() {
    if (!selectedId) return;
    await operation("queueResume", { sessionId: selectedId }).catch(() => undefined);
    await readQueue();
  }

  async function signOut() {
    try { await logout(csrf); }
    catch { /* The server may already have revoked this cookie. */ }
    expireSession();
  }

  async function answerApproval(optionId: string) {
    if (!pendingApproval || !selectedId) return;
    try {
      await resolveApproval(pendingApproval.id, selectedId, optionId, csrf);
      setPendingApproval(undefined);
      setApprovalOpen(false);
      setError("");
    } catch (cause) { handleApiError(cause); throw cause; }
  }

  const onAuthenticated = useCallback((nextDevice: MobileDevice, nextCsrf: string) => {
    setDevice(nextDevice);
    setCsrf(nextCsrf);
    setError("");
  }, []);

  if (!device) {
    return <><Pairing onAuthenticated={onAuthenticated} />{error && <p className="fixed bottom-4 left-4 right-4 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]" role="alert">{error}</p>}</>;
  }

  if (!snapshot) return <main className="flex min-h-[100svh] items-center justify-center gap-3 text-sm text-muted"><LoaderCircle size={18} className="animate-spin text-accent" /> Подключаю Codex…</main>;

  return <div className="safe-area-top flex h-[100svh] min-h-[100svh] flex-col overflow-hidden">
    <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-border bg-[#141815] px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Button variant="ghost" className="min-h-10 px-2 md:hidden" aria-label="Открыть список сеансов" onClick={() => setWorkspaceOpen(true)}><Menu size={20} /></Button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#46533d] bg-[#20291b] text-accent"><span className="font-mono text-sm font-bold">C</span></div>
        <div className="min-w-0"><p className="truncate text-sm font-bold tracking-tight">Codex Mobile</p><p className="truncate text-[10px] text-muted">{snapshot.online ? "Локальный Codex runtime" : "Соединение с Codex потеряно"}</p></div>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden text-[11px] text-muted sm:inline">{streamConnected ? "Поток активен" : "Переподключение…"}</span>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Обновить" onClick={() => void refreshSnapshot(true)} disabled={refreshing}>{refreshing ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}</Button>
        {pendingApproval && <Button variant="outline" className="min-h-10 px-2 text-[#f2c66d]" aria-label="Открыть подтверждение" onClick={() => setApprovalOpen(true)}><ShieldAlert size={17} /></Button>}
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Файлы проекта" onClick={() => setFilesOpen(true)} disabled={!selectedId}><FolderOpen size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Git и изменения" onClick={() => setGitOpen(true)} disabled={!selectedId}><GitBranch size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Настройки Codex" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Устройства и безопасность" onClick={() => setDevicesOpen(true)}><Shield size={17} /><span className="sr-only">Устройства</span></Button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <Workspace snapshot={snapshot} selectedProject={selectedProject} search={search} selectedId={selectedId}
        open={workspaceOpen} connectedIds={connectedIds} onProjectChange={setSelectedProject} onSearchChange={setSearch}
        onSelect={setSelectedId} onCreate={() => void createSession()} onClose={() => setWorkspaceOpen(false)}
        onArchive={archiveSession} onUnarchive={unarchiveSession} onRename={renameSession} />
      <Conversation session={selectedSession} history={history} activity={activity} events={events} queue={queue}
        connected={connected} connecting={connecting} loading={loading} streamConnected={streamConnected}
        error={error} includeTools={includeTools} onToggleTools={() => setIncludeTools((value) => !value)}
        onConnect={() => void connectSession()} onCancel={() => void cancel()} onFork={() => void forkSession()} forking={forking}
        onCompact={compactSession} compacting={compacting} onSend={send}
        onQueueRemove={(id) => void removeQueued(id)} onQueueResume={() => void resumeQueue()}
        onQueueOpen={readQueue} />
    </div>
    {devicesOpen && <DevicePanel current={device} csrf={csrf} onClose={() => setDevicesOpen(false)} onLogout={() => { setDevicesOpen(false); expireSession(); }} onSignOut={() => void signOut()} />}
    {settingsOpen && <SettingsPanel sessionId={selectedId} connected={connected} onClose={() => setSettingsOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {filesOpen && selectedId && <FilesPanel sessionId={selectedId} connected={connected} onClose={() => setFilesOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {gitOpen && selectedId && <GitPanel key={selectedId} sessionId={selectedId} connected={connected} onClose={() => setGitOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {approvalOpen && pendingApproval && <ApprovalPanel approval={pendingApproval} onResolve={answerApproval} onClose={() => setApprovalOpen(false)} />}
  </div>;
}
