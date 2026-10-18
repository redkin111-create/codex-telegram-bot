import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, GitBranch, LoaderCircle, Menu, RefreshCw, Shield, ShieldAlert, SlidersHorizontal, Terminal } from "lucide-react";
import {
  asLiveEvent, logout, MobileApiError, openEventStream, parseSseBlock, readActivity, readApprovals, readElicitations,
  readCapabilities, readHistory, readSession, readSnapshot, removeAttachment, resolveApproval, resolveElicitation, runOperation, transcribeAudio as transcribeAudioRequest, uploadAttachment,
} from "./api.js";
import { ApprovalPanel } from "./components/approval-panel.js";
import { ElicitationPanel } from "./components/elicitation-panel.js";
import { Conversation, type FollowUpMode, type PromptImage } from "./components/conversation.js";
import { DevicePanel } from "./components/device-panel.js";
import { FilesPanel } from "./components/files-panel.js";
import { GitPanel } from "./components/git-panel.js";
import { Pairing } from "./components/pairing.js";
import { SettingsPanel } from "./components/settings-panel.js";
import { Workspace } from "./components/workspace.js";
import type {
  HistoryEntry, MobileActivity, MobileApproval, MobileAttachment, MobileDevice, MobileElicitation, MobileElicitationAction, MobileEditableTurns, MobileHistorySearch, MobileLiveEvent, MobileQueue, MobileRealtimeVoices, MobileSession, MobileSnapshot,
  MobileOperation,
} from "./types.js";
import { Button } from "./components/ui/primitives.js";

const TerminalPanel = lazy(() => import("./components/terminal-panel.js").then((module) => ({ default: module.TerminalPanel })));

const emptyQueue: MobileQueue = { items: [], busy: false, paused: false };
type SessionPage = { sessions: MobileSession[]; nextOffset?: number; loaded: boolean; loading: boolean };

export default function App() {
  const [device, setDevice] = useState<MobileDevice>();
  const [csrf, setCsrf] = useState("");
  const [snapshot, setSnapshot] = useState<MobileSnapshot>();
  const [selectedId, setSelectedId] = useState("");
  const [selectedSearchSession, setSelectedSearchSession] = useState<MobileSession>();
  const [selectedProject, setSelectedProject] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [searchResults, setSearchResults] = useState<MobileSession[]>();
  const [searchCursor, setSearchCursor] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMoreLoading, setSearchMoreLoading] = useState(false);
  const [sessionPages, setSessionPages] = useState<Record<string, SessionPage>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activity, setActivity] = useState<MobileActivity>();
  const [queue, setQueue] = useState<MobileQueue>(emptyQueue);
  const [events, setEvents] = useState<MobileLiveEvent[]>([]);
  const [includeTools, setIncludeTools] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [forking, setForking] = useState(false);
  const [sideChatting, setSideChatting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitReviewLocation, setGitReviewLocation] = useState<{ sessionId: string; path: string; line?: number }>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<MobileApproval>();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [pendingElicitation, setPendingElicitation] = useState<MobileElicitation>();
  const [elicitationOpen, setElicitationOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const eventCursor = useRef(0);
  const eventEpoch = useRef("");
  const eventSession = useRef("");
  const selectedIdRef = useRef("");
  selectedIdRef.current = selectedId;
  const pendingSend = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  const searchGeneration = useRef(0);
  const sessionPageRequests = useRef(new Set<string>());

  const expireSession = useCallback(() => {
    setDevice(undefined);
    setCsrf("");
    setSnapshot(undefined);
    setSelectedId("");
    setSelectedSearchSession(undefined);
    setSearchResults(undefined);
    setSearchCursor("");
    setSearchMoreLoading(false);
    setSearchLoading(false);
    setSessionPages({});
    sessionPageRequests.current.clear();
    setHistory([]);
    setActivity(undefined);
    setQueue(emptyQueue);
    setEvents([]);
    setDevicesOpen(false);
    setSettingsOpen(false);
    setFilesOpen(false);
    setGitOpen(false);
    setTerminalOpen(false);
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

  const loadMobileSkills = useCallback(async () => {
    if (!selectedId) return [];
    try { return (await readCapabilities(selectedId)).skills; }
    catch (cause) { handleApiError(cause); throw cause; }
  }, [selectedId, handleApiError]);

  const loadMobileApps = useCallback(async () => {
    if (!selectedId) return [];
    try { return (await readCapabilities(selectedId)).apps; }
    catch (cause) { handleApiError(cause); throw cause; }
  }, [selectedId, handleApiError]);

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
    () => snapshot?.sessions.find((session) => session.id === selectedId) ?? snapshot?.archivedSessions?.find((session) => session.id === selectedId) ??
      (selectedSearchSession?.id === selectedId ? selectedSearchSession : undefined),
    [snapshot?.sessions, snapshot?.archivedSessions, selectedId, selectedSearchSession],
  );
  const connectedIds = useMemo(
    () => new Set(snapshot?.controlled.map((session) => session.id) ?? []),
    [snapshot?.controlled],
  );
  const connected = !selectedSession?.archived && connectedIds.has(selectedId);
  const sessionPageKey = `${showArchived ? "archived" : "active"}:${selectedProject}`;
  const currentSessionPage = sessionPages[sessionPageKey];
  const baseProjectSessions = useMemo(
    () => (showArchived ? snapshot?.archivedSessions ?? [] : snapshot?.sessions ?? [])
      .filter((session) => !selectedProject || session.cwd === selectedProject),
    [snapshot?.sessions, snapshot?.archivedSessions, selectedProject, showArchived],
  );

  useEffect(() => {
    if (!device || !selectedId) {
      setHistory([]);
      setActivity(undefined);
      setQueue(emptyQueue);
      setPendingApproval(undefined);
      setApprovalOpen(false);
      setPendingElicitation(undefined);
      setElicitationOpen(false);
      return;
    }
    setPendingApproval(undefined);
    setPendingElicitation(undefined);
    setElicitationOpen(false);
    void readApprovals(selectedId).then(({ approvals }) => {
      const current = approvals[0];
      setPendingApproval(current);
      if (current) setApprovalOpen(true);
    }).catch(handleApiError);
    void readElicitations(selectedId).then(({ elicitations }) => {
      const current = elicitations[0];
      setPendingElicitation(current);
      if (current) setElicitationOpen(true);
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
                  } else if (event.kind === "elicitation") {
                    void readElicitations(selectedId).then(({ elicitations }) => {
                      if (selectedIdRef.current !== selectedId) return;
                      const current = elicitations[0];
                      setPendingElicitation(current);
                      setElicitationOpen(Boolean(current));
                    }).catch(handleApiError);
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
      if (op === "create" || op === "forkThread" || op === "archiveThread" || op === "unarchiveThread" || op === "renameThread" || op === "deleteThread" || op === "createWorktree") {
        setSessionPages({});
      }
      if (!op.startsWith("terminal") && op !== "listMoreThreads" && op !== "searchThreads" && op !== "searchHistory" && op !== "updateThreadReadState") void refreshSnapshot();
      return result;
    } catch (cause) { handleApiError(cause); throw cause; }
  }, [csrf, handleApiError, refreshSnapshot]);

  const updateSessionReadState = useCallback(async (sessionId: string, expectedRevision: string, readOperation: "read" | "unread") => {
    try {
      await operation("updateThreadReadState", { sessionId, expectedRevision, operation: readOperation });
      await refreshSnapshot();
    } catch (cause) {
      void refreshSnapshot();
      throw cause;
    }
  }, [operation, refreshSnapshot]);

  useEffect(() => {
    const query = search.trim();
    const generation = ++searchGeneration.current;
    setSearchResults(undefined);
    setSearchCursor("");
    setSearchMoreLoading(false);
    if (!device || query.length < 2) { setSearchLoading(false); return; }
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void operation<{ sessions: MobileSession[]; nextCursor?: string }>("searchThreads", {
        query, archived: showArchived, ...(selectedProject ? { cwd: selectedProject } : {}),
      }).then((result) => {
        if (searchGeneration.current !== generation) return;
        setSearchResults(result.sessions);
        setSearchCursor(result.nextCursor ?? "");
      }).catch(() => {
        if (searchGeneration.current === generation) setSearchResults([]);
      }).finally(() => {
        if (searchGeneration.current === generation) setSearchLoading(false);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (searchGeneration.current === generation) searchGeneration.current++;
    };
  }, [device, search, selectedProject, showArchived, operation]);

  async function loadMoreSearch() {
    const query = search.trim();
    const cursor = searchCursor;
    if (!device || query.length < 2 || !cursor || searchMoreLoading) return;
    const generation = searchGeneration.current;
    setSearchMoreLoading(true);
    try {
      const result = await operation<{ sessions: MobileSession[]; nextCursor?: string }>("searchThreads", {
        query, cursor, archived: showArchived, ...(selectedProject ? { cwd: selectedProject } : {}),
      });
      if (searchGeneration.current !== generation) return;
      setSearchResults((current) => {
        const known = new Set((current ?? []).map((session) => session.id));
        return [...current ?? [], ...result.sessions.filter((session) => !known.has(session.id))];
      });
      setSearchCursor(result.nextCursor ?? "");
    } catch { /* The app-level alert reports the Codex search error. */ }
    finally { if (searchGeneration.current === generation) setSearchMoreLoading(false); }
  }

  async function loadMoreSessions() {
    if (!device || !snapshot || search.trim().length >= 2 || sessionPageRequests.current.has(sessionPageKey)) return;
    const page = sessionPages[sessionPageKey];
    if (page?.loaded && page.nextOffset === undefined) return;
    const offset = page?.nextOffset ?? baseProjectSessions.length + (page?.sessions.length ?? 0);
    sessionPageRequests.current.add(sessionPageKey);
    setSessionPages((current) => ({ ...current, [sessionPageKey]: { ...(current[sessionPageKey] ?? { sessions: [], loaded: false }), loading: true } }));
    try {
      const result = await operation<{ sessions: MobileSession[]; nextOffset?: number }>("listMoreThreads", {
        offset, archived: showArchived, ...(selectedProject ? { cwd: selectedProject } : {}),
      });
      setSessionPages((current) => {
        const previous = current[sessionPageKey] ?? { sessions: [], loaded: false, loading: false };
        const known = new Set([...baseProjectSessions, ...previous.sessions].map((session) => session.id));
        return {
          ...current,
          [sessionPageKey]: {
            sessions: [...previous.sessions, ...result.sessions.filter((session) => !known.has(session.id))],
            nextOffset: result.nextOffset,
            loaded: true,
            loading: false,
          },
        };
      });
    } catch {
      setSessionPages((current) => ({ ...current, [sessionPageKey]: { ...(current[sessionPageKey] ?? { sessions: [], loaded: false }), loading: false } }));
    } finally {
      sessionPageRequests.current.delete(sessionPageKey);
    }
  }

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
      setSelectedSearchSession(undefined);
      setSelectedId(created.sessionId);
      setWorkspaceOpen(false);
      await refreshSnapshot();
    } catch { /* The error is shown in the conversation panel. */ }
  }

  function selectWorkspaceSession(id: string) {
    setSelectedSearchSession(searchResults?.find((session) => session.id === id));
    setSelectedId(id);
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

  async function createSideChat() {
    if (!selectedId || sideChatting || selectedSession?.archived || selectedSession?.ephemeral) return;
    setSideChatting(true);
    try {
      const sideChat = await operation<{ sessionId: string }>("createSideChat", { sessionId: selectedId });
      await operation("select", { sessionId: sideChat.sessionId });
      setSelectedSearchSession(undefined);
      setSelectedId(sideChat.sessionId);
      setWorkspaceOpen(false);
      await refreshSnapshot();
    } catch { /* Keep the original session selected if Codex lacks ephemeral fork support. */ }
    finally { setSideChatting(false); }
  }

  async function returnToParent() {
    const parentId = selectedSession?.ephemeral ? selectedSession.parentThreadId : undefined;
    if (!parentId) return;
    try {
      await operation("select", { sessionId: parentId });
      setSelectedSearchSession(undefined);
      setSelectedId(parentId);
      setWorkspaceOpen(false);
      await refreshSnapshot();
    } catch { /* Keep the side chat open if the parent is no longer available. */ }
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

  async function deleteSession(sessionId: string) {
    await operation("deleteThread", { sessionId });
    setSearchResults((current) => current?.filter((session) => session.id !== sessionId));
    if (selectedId === sessionId) {
      setSelectedId("");
      setSelectedSearchSession(undefined);
      setHistory([]);
      setActivity(undefined);
      setQueue(emptyQueue);
      setEvents([]);
    }
    await refreshSnapshot(true);
  }

  async function createThreadSection(name: string) {
    await operation("createThreadSection", { name });
    await refreshSnapshot();
  }

  async function renameThreadSection(sectionId: string, name: string) {
    await operation("renameThreadSection", { sectionId, name });
    await refreshSnapshot();
  }

  async function deleteThreadSection(sectionId: string) {
    await operation("deleteThreadSection", { sectionId });
    await refreshSnapshot();
  }

  async function moveSessionToSection(sessionId: string, sectionId: string | null) {
    await operation("moveThreadToSection", { sessionId, sectionId });
    await refreshSnapshot();
  }

  async function send(text: string, images: PromptImage[], attachments: MobileAttachment[], mode: FollowUpMode, appIds: string[]) {
    if (!selectedId) return;
    if (mode === "steer" && attachments.length) throw new Error("Файлы можно отправить в очередь, но не добавить к активному ходу");
    const fingerprint = JSON.stringify([selectedId, mode, text, images.map((image) => [image.name, image.mimeType, image.data.length]), attachments.map((file) => file.id), appIds]);
    if (!pendingSend.current || pendingSend.current.fingerprint !== fingerprint) {
      pendingSend.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    if (mode === "steer") {
      await operation("steer", {
        sessionId: selectedId, text, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        attachmentIds: attachments.map((file) => file.id), appIds, requestId: pendingSend.current.requestId,
      });
    } else {
      await operation("send", {
        sessionId: selectedId, text, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        attachmentIds: attachments.map((file) => file.id), appIds, requestId: pendingSend.current.requestId,
      });
    }
    pendingSend.current = undefined;
    setTimeout(() => { void refreshSnapshot(); }, 500);
  }

  async function loadEditableTurns(): Promise<MobileEditableTurns> {
    if (!selectedId) throw new Error("Сначала выберите сеанс Codex");
    return operation<MobileEditableTurns>("listEditableTurns", { sessionId: selectedId });
  }

  async function transcribeVoice(file: File): Promise<string> {
    if (!selectedId) throw new Error("Сначала выберите сеанс Codex");
    const result = await transcribeAudioRequest(selectedId, file, csrf);
    return result.text;
  }

  const loadRealtimeVoices = useCallback(async (): Promise<MobileRealtimeVoices> => {
    if (!selectedId) throw new Error("Сначала выберите сеанс Codex");
    return runOperation<MobileRealtimeVoices>("listRealtimeVoices", { sessionId: selectedId }, csrf);
  }, [csrf, selectedId]);

  const startRealtime = useCallback(async (offerSdp: string, voice?: string): Promise<string> => {
    if (!selectedId) throw new Error("Сначала выберите сеанс Codex");
    try {
      const result = await runOperation<{ sdp: string }>("startRealtime", { sessionId: selectedId, sdp: offerSdp, ...(voice ? { voice } : {}) }, csrf);
      if (typeof result.sdp !== "string" || !result.sdp) throw new Error("Codex не вернул SDP-ответ для голосового режима");
      return result.sdp;
    } catch (cause) { handleApiError(cause); throw cause; }
  }, [csrf, handleApiError, selectedId]);

  const stopRealtime = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    try { await runOperation("stopRealtime", { sessionId: selectedId }, csrf); }
    catch (cause) { handleApiError(cause); throw cause; }
  }, [csrf, handleApiError, selectedId]);

  async function editAndRetry(turnId: string, text: string, expectedLatestTurnId: string) {
    const targetSession = selectedId;
    if (!targetSession) throw new Error("Сначала выберите сеанс Codex");
    await operation("editAndRetry", { sessionId: targetSession, turnId, expectedLatestTurnId, text, requestId: crypto.randomUUID() });
    pendingSend.current = undefined;
    const [nextHistory, nextActivity] = await Promise.all([readHistory(targetSession, includeTools), readActivity(targetSession)]);
    if (selectedIdRef.current === targetSession) {
      setHistory(nextHistory.entries);
      setActivity(nextActivity);
    }
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

  async function answerElicitation(action: MobileElicitationAction, content?: Record<string, unknown>) {
    if (!pendingElicitation || !selectedId) return;
    try {
      await resolveElicitation(pendingElicitation.id, selectedId, action, content, csrf);
      setPendingElicitation(undefined);
      setElicitationOpen(false);
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
        {pendingElicitation && <Button variant="outline" className="min-h-10 px-2 text-accent" aria-label="Открыть запрос MCP" onClick={() => setElicitationOpen(true)}><ShieldAlert size={17} /></Button>}
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Файлы проекта" onClick={() => setFilesOpen(true)} disabled={!selectedId}><FolderOpen size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Git и изменения" onClick={() => { setGitReviewLocation(undefined); setGitOpen(true); }} disabled={!selectedId}><GitBranch size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Терминал проекта" onClick={() => setTerminalOpen(true)} disabled={!selectedId}><Terminal size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Настройки Codex" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} /></Button>
        <Button variant="ghost" className="min-h-10 px-2" aria-label="Устройства и безопасность" onClick={() => setDevicesOpen(true)}><Shield size={17} /><span className="sr-only">Устройства</span></Button>
      </div>
    </header>
    <div className="flex min-h-0 flex-1">
      <Workspace snapshot={snapshot} selectedProject={selectedProject} search={search} searchResults={searchResults}
        searchCursor={searchCursor} searchLoading={searchLoading} searchMoreLoading={searchMoreLoading}
        extraSessions={currentSessionPage?.sessions ?? []} sessionsMoreLoading={currentSessionPage?.loading ?? false}
        sessionsHasMore={!currentSessionPage?.loaded || currentSessionPage.nextOffset !== undefined}
        onLoadMoreSessions={() => void loadMoreSessions()}
        showArchived={showArchived} onArchivedChange={setShowArchived} onLoadMore={() => void loadMoreSearch()} selectedId={selectedId}
        open={workspaceOpen} connectedIds={connectedIds} onProjectChange={setSelectedProject} onSearchChange={setSearch}
        onSelect={selectWorkspaceSession} onCreate={() => void createSession()} onClose={() => setWorkspaceOpen(false)}
        onArchive={archiveSession} onUnarchive={unarchiveSession} onRename={renameSession} onDelete={deleteSession}
        onCreateSection={createThreadSection} onRenameSection={renameThreadSection} onDeleteSection={deleteThreadSection}
        onMoveSession={moveSessionToSection} onUpdateReadState={updateSessionReadState} />
      <Conversation session={selectedSession} history={history} activity={activity} events={events} queue={queue}
        connected={connected} connecting={connecting} loading={loading} streamConnected={streamConnected}
        error={error} includeTools={includeTools} onToggleTools={() => setIncludeTools((value) => !value)}
        onConnect={() => void connectSession()} onCancel={() => void cancel()} onFork={() => void forkSession()} forking={forking}
        onCreateSideChat={() => void createSideChat()} sideChatting={sideChatting} onReturnToParent={() => void returnToParent()}
        onCompact={compactSession} compacting={compacting} onSend={send}
        onLoadSkills={loadMobileSkills}
        onLoadApps={loadMobileApps}
        onSearchHistory={(query, beforeOffset, revision) => operation<MobileHistorySearch>("searchHistory", { sessionId: selectedId, query, includeTools, ...(beforeOffset === undefined ? {} : { beforeOffset, revision }) })}
        onLoadEditableTurns={loadEditableTurns} onEditAndRetry={editAndRetry} onTranscribeAudio={transcribeVoice} onLoadRealtimeVoices={loadRealtimeVoices}
        onStartRealtime={startRealtime} onStopRealtime={stopRealtime}
        onUploadAttachment={(sessionId, file) => uploadAttachment(sessionId, file, csrf)}
        onRemoveAttachment={(sessionId, id) => removeAttachment(sessionId, id, csrf)}
        onQueueRemove={(id) => void removeQueued(id)} onQueueResume={() => void resumeQueue()}
        onOpenReviewLocation={(location) => { if (!selectedId) return; setGitReviewLocation({ sessionId: selectedId, ...location }); setGitOpen(true); }}
        onQueueOpen={readQueue} />
    </div>
    {devicesOpen && <DevicePanel current={device} csrf={csrf} onClose={() => setDevicesOpen(false)} onLogout={() => { setDevicesOpen(false); expireSession(); }} onSignOut={() => void signOut()} />}
    {settingsOpen && <SettingsPanel sessionId={selectedId} connected={connected} csrf={csrf} onAccountChanged={() => void refreshSnapshot(true)} onClose={() => setSettingsOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {filesOpen && selectedId && <FilesPanel sessionId={selectedId} connected={connected} onClose={() => setFilesOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {gitOpen && selectedId && <GitPanel key={selectedId} sessionId={selectedId} connected={connected} initialReviewLocation={gitReviewLocation?.sessionId === selectedId ? gitReviewLocation : undefined} onClose={() => { setGitOpen(false); setGitReviewLocation(undefined); }} onOperation={(op: MobileOperation, args) => operation(op, args)} onWorktreeCreated={async (id, path) => { await operation("select", { sessionId: id }); setSelectedSearchSession(undefined); setSelectedId(id); setSelectedProject(path); setGitOpen(false); setGitReviewLocation(undefined); setWorkspaceOpen(false); }} />}
    {terminalOpen && selectedId && selectedSession && <Suspense fallback={<div role="status" className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted">Открываю терминал…</div>}><TerminalPanel sessionId={selectedId} cwd={selectedSession.cwd} connected={connected} onClose={() => setTerminalOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} /></Suspense>}
    {approvalOpen && pendingApproval && <ApprovalPanel approval={pendingApproval} onResolve={answerApproval} onClose={() => setApprovalOpen(false)} />}
    {elicitationOpen && pendingElicitation && <ElicitationPanel elicitation={pendingElicitation} onResolve={answerElicitation} onClose={() => setElicitationOpen(false)} />}
  </div>;
}
