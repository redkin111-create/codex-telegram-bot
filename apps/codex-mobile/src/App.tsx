import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Menu } from "lucide-react";
import {
  logout, MobileApiError, mobileSubmissionOutcome, openEventStream, readActivity, readApprovals, readElicitations,
  readAppInventory, readHistory, readSession, readSkillInventory, readSnapshot, removeAttachment, resolveApproval, resolveElicitation, runOperation, uploadAttachment,
} from "./api.js";
import { coalesceInFlight } from "./single-flight.js";
import { clearSessionDraftIfUnchanged, emptyMobileComposerDraft, isCurrentMobileAuthScope, isCurrentMobileSessionSync, mobileDraftKey, MobileSubmissionLock, PendingMobileSendIds, mobileSendFingerprint, setSessionDraft, updateCurrentSessionState, type MobileAuthScope, type MobileComposerDraft } from "./lib/session-state.js";
import { consumeMobileEventStream, MobileEventBuffer } from "./lib/event-stream.js";
import { ApprovalPanel } from "./components/approval-panel.js";
import { ElicitationPanel } from "./components/elicitation-panel.js";
import { Conversation, type FollowUpMode, type PromptImage } from "./components/conversation.js";
import { DevicePanel } from "./components/device-panel.js";
import { FilesPanel } from "./components/files-panel.js";
import { GitPanel } from "./components/git-panel.js";
import { Pairing } from "./components/pairing.js";
import { SettingsPanel } from "./components/settings-panel.js";
import { Workspace } from "./components/workspace.js";
import { MobileHeaderActions } from "./components/mobile-header-actions.js";
import type {
  HistoryEntry, MobileActivity, MobileApproval, MobileAttachment, MobileDevice, MobileElicitation, MobileElicitationAction, MobileEditableTurns, MobileHistorySearch, MobileLiveEvent, MobileQueue, MobileScreenshotPage, MobileSession, MobileSnapshot,
  MobileOperation,
} from "./types.js";
import { Button } from "./components/ui/primitives.js";

const TerminalPanel = lazy(() => import("./components/terminal-panel.js").then((module) => ({ default: module.TerminalPanel })));

const emptyQueue: MobileQueue = { items: [], busy: false, paused: false };
type SessionPage = { sessions: MobileSession[]; nextCursor?: string; loaded: boolean; loading: boolean };
interface MobileSessionView {
  history: HistoryEntry[];
  activity?: MobileActivity;
  queue: MobileQueue;
  events: MobileLiveEvent[];
  loading: boolean;
  streamConnected: boolean;
  pendingApproval?: MobileApproval;
  approvalOpen: boolean;
  pendingElicitation?: MobileElicitation;
  elicitationOpen: boolean;
}
const emptySessionView = (): MobileSessionView => ({
  history: [], activity: undefined, queue: emptyQueue, events: [], loading: false, streamConnected: false,
  pendingApproval: undefined, approvalOpen: false, pendingElicitation: undefined, elicitationOpen: false,
});

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
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({});
  const [composerDraftsBySession, setComposerDraftsBySession] = useState<Record<string, MobileComposerDraft>>({});
  const [draftScopeEpoch, setDraftScopeEpoch] = useState(0);
  const [sessionSwitchNotice, setSessionSwitchNotice] = useState("");
  const [sessionViewState, setSessionViewState] = useState<{ sessionId: string; value: MobileSessionView }>({ sessionId: "", value: emptySessionView() });
  const [includeTools, setIncludeTools] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [forking, setForking] = useState(false);
  const [sideChatting, setSideChatting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitReviewLocation, setGitReviewLocation] = useState<{ sessionId: string; path: string; line?: number }>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selectedIdRef = useRef("");
  selectedIdRef.current = selectedId;
  const sessionSelection = useRef({ sessionId: "", generation: 0 });
  if (sessionSelection.current.sessionId !== selectedId) {
    sessionSelection.current = { sessionId: selectedId, generation: sessionSelection.current.generation + 1 };
  }
  const lastSelectedSessionId = useRef("");
  const pendingSend = useRef(new PendingMobileSendIds());
  const submissionLocks = useRef(new Map<string, MobileSubmissionLock>());
  const searchGeneration = useRef(0);
  const sessionPageRequests = useRef(new Map<string, object>());
  const sessionPagesGeneration = useRef(0);
  const snapshotRequest = useRef<Promise<void> | undefined>(undefined);
  const authScope = useRef({ generation: 0, deviceId: "" });
  const syncRequestGeneration = useRef(0);
  const liveEventRevision = useRef(0);
  const includeToolsRef = useRef(includeTools);
  includeToolsRef.current = includeTools;
  const eventBuffer = useRef<MobileEventBuffer | undefined>(undefined);
  const sessionView = sessionViewState.sessionId === selectedId ? sessionViewState.value : { ...emptySessionView(), loading: Boolean(selectedId) };
  const { history, activity, queue, events, loading, streamConnected, pendingApproval, approvalOpen, pendingElicitation, elicitationOpen } = sessionView;

  function submissionLockFor(sessionId: string): MobileSubmissionLock {
    let lock = submissionLocks.current.get(sessionId);
    if (!lock) {
      lock = new MobileSubmissionLock();
      submissionLocks.current.set(sessionId, lock);
    }
    return lock;
  }

  function updateComposerDraft(sessionId: string, update: (current: MobileComposerDraft) => MobileComposerDraft) {
    const key = mobileDraftKey(device?.id ?? "", draftScopeEpoch, sessionId);
    setComposerDraftsBySession((current) => {
      const previous = current[key] ?? emptyMobileComposerDraft();
      const next = update(previous);
      return next === previous ? current : { ...current, [key]: next };
    });
  }

  useEffect(() => {
    if (!selectedId) {
      setSessionSwitchNotice("");
      return;
    }
    const previous = lastSelectedSessionId.current;
    lastSelectedSessionId.current = selectedId;
    if (!previous || previous === selectedId) return;
    setSessionSwitchNotice("Текст и фото хранятся отдельно. Неотправленные файлы очищаются при переключении; незавершённая отправка сохраняет свои файлы и приложения.");
    const timeout = setTimeout(() => setSessionSwitchNotice(""), 8_000);
    return () => clearTimeout(timeout);
  }, [selectedId]);

  const patchSessionView = useCallback((targetSessionId: string, update: (current: MobileSessionView) => MobileSessionView) => {
    setSessionViewState((current) => updateCurrentSessionState(
      current, selectedIdRef.current, targetSessionId, emptySessionView(), update,
    ));
  }, []);

  const expireSession = useCallback(() => {
    authScope.current = { generation: authScope.current.generation + 1, deviceId: "" };
    snapshotRequest.current = undefined;
    setRefreshing(false);
    setDraftsBySession({});
    setComposerDraftsBySession({});
    setDraftScopeEpoch((epoch) => epoch + 1);
    submissionLocks.current.clear();
    setDevice(undefined);
    setCsrf("");
    setSnapshot(undefined);
    setSelectedProject("");
    setSelectedId("");
    setSelectedSearchSession(undefined);
    setSearchResults(undefined);
    setSearchCursor("");
    setSearchMoreLoading(false);
    setSearchLoading(false);
    setSessionPages({});
    sessionPagesGeneration.current++;
    sessionPageRequests.current.clear();
    setSessionViewState({ sessionId: "", value: emptySessionView() });
    setDevicesOpen(false);
    setSettingsOpen(false);
    setFilesOpen(false);
    setGitOpen(false);
    setTerminalOpen(false);
  }, []);

  const handleApiError = useCallback((cause: unknown, requestScope?: MobileAuthScope) => {
    if (requestScope && !isCurrentMobileAuthScope(authScope.current, requestScope.generation, requestScope.deviceId)) return;
    if (cause instanceof MobileApiError && cause.status === 401) {
      expireSession();
      return;
    }
    setError(cause instanceof Error ? cause.message : "Не удалось связаться с Codex");
  }, [expireSession]);

  const loadMobileSkills = useCallback(async () => {
    if (!selectedId) return [];
    const requestScope = authScope.current;
    try { return (await readSkillInventory(selectedId)).skills; }
    catch (cause) { handleApiError(cause, requestScope); throw cause; }
  }, [selectedId, handleApiError]);

  const loadMobileApps = useCallback(async () => {
    if (!selectedId) return [];
    const requestScope = authScope.current;
    try { return (await readAppInventory(selectedId)).apps; }
    catch (cause) { handleApiError(cause, requestScope); throw cause; }
  }, [selectedId, handleApiError]);

  const refreshSnapshot = useCallback((showSpinner = false) => {
    const requestScope = authScope.current;
    const requestGeneration = requestScope.generation;
    const requestDeviceId = requestScope.deviceId;
    if (showSpinner && !snapshotRequest.current) setRefreshing(true);
    return coalesceInFlight(snapshotRequest, async () => {
      try {
        const next = await readSnapshot();
        if (!isCurrentMobileAuthScope(authScope.current, requestGeneration, requestDeviceId)) return;
        setSnapshot(next);
        setSelectedProject((current) => current || next.projects[0]?.path || "");
        setSelectedId((current) => current || next.selected || "");
        setError("");
      } catch (cause) {
        if (isCurrentMobileAuthScope(authScope.current, requestGeneration, requestDeviceId)) handleApiError(cause, requestScope);
      }
      finally {
        if (showSpinner && isCurrentMobileAuthScope(authScope.current, requestGeneration, requestDeviceId)) setRefreshing(false);
      }
    });
  }, [handleApiError]);

  useEffect(() => {
    let alive = true;
    const requestGeneration = authScope.current.generation;
    void readSession().then((value) => {
      if (!alive || authScope.current.generation !== requestGeneration) return;
      authScope.current = { generation: authScope.current.generation + 1, deviceId: value.device?.id ?? "" };
      setDevice(value.device);
      setCsrf(value.csrfToken);
    }).catch((cause: unknown) => {
      if (alive && authScope.current.generation === requestGeneration && !(cause instanceof MobileApiError && cause.status === 401)) {
        handleApiError(cause, { generation: requestGeneration, deviceId: authScope.current.deviceId });
      }
    });
    return () => { alive = false; };
  }, [handleApiError]);

  useEffect(() => {
    if (!device) return;
    void refreshSnapshot();
    const timer = window.setInterval(() => { void refreshSnapshot(); }, 30_000);
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
  const activityBusy = selectedSession?.busy === true || activity?.busy === true || queue.busy;
  const sessionPageKey = `${showArchived ? "archived" : "active"}:${selectedProject}`;
  const currentSessionPage = sessionPages[sessionPageKey];
  const baseProjectSessions = useMemo(
    () => (showArchived ? snapshot?.archivedSessions ?? [] : snapshot?.sessions ?? [])
      .filter((session) => !selectedProject || session.cwd === selectedProject),
    [snapshot?.sessions, snapshot?.archivedSessions, selectedProject, showArchived],
  );

  useEffect(() => {
    if (!device || !selectedId) {
      setSessionViewState({ sessionId: "", value: emptySessionView() });
      eventBuffer.current?.setSession("");
      return;
    }
    patchSessionView(selectedId, (current) => ({ ...current, loading: true, streamConnected: false, events: [], pendingApproval: undefined, approvalOpen: false, pendingElicitation: undefined, elicitationOpen: false }));
    let alive = true;
    const requestScope = authScope.current;
    const historyRequest: { current?: Promise<void> } = {};
    const load = () => coalesceInFlight(historyRequest, async () => {
      patchSessionView(selectedId, (current) => ({ ...current, loading: true }));
      try {
        const result = await readHistory(selectedId, includeTools);
        if (alive) patchSessionView(selectedId, (current) => ({ ...current, history: result.entries }));
      } catch (cause) { if (alive) handleApiError(cause, requestScope); }
      finally { if (alive) patchSessionView(selectedId, (current) => ({ ...current, loading: false })); }
      const [approvalResult, elicitationResult] = await Promise.allSettled([
        readApprovals(selectedId), readElicitations(selectedId),
      ]);
      if (alive) {
        if (approvalResult.status === "fulfilled") {
          patchSessionView(selectedId, (current) => ({ ...current, pendingApproval: approvalResult.value.approvals[0], approvalOpen: approvalResult.value.approvals.length > 0 }));
        } else handleApiError(approvalResult.reason, requestScope);
        if (elicitationResult.status === "fulfilled") {
          patchSessionView(selectedId, (current) => ({ ...current, pendingElicitation: elicitationResult.value.elicitations[0], elicitationOpen: elicitationResult.value.elicitations.length > 0 }));
        } else handleApiError(elicitationResult.reason, requestScope);
        }
      if (connected) {
        try {
          const nextQueue = await runOperation<MobileQueue>("queue", { sessionId: selectedId }, csrf);
          if (alive) patchSessionView(selectedId, (current) => ({ ...current, queue: nextQueue }));
        } catch (cause) { if (alive) handleApiError(cause, requestScope); }
      } else if (alive) patchSessionView(selectedId, (current) => ({ ...current, queue: emptyQueue }));
    });
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [device, selectedId, includeTools, connected, csrf, handleApiError, patchSessionView]);

  useEffect(() => {
    if (!device || !selectedId) return;
    let alive = true;
    const requestScope = authScope.current;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await readActivity(selectedId);
        if (alive) patchSessionView(selectedId, (current) => ({ ...current, activity: next }));
      } catch (cause) {
        if (alive) handleApiError(cause, requestScope);
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, activityBusy ? 5_000 : 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [device, selectedId, activityBusy, handleApiError, patchSessionView]);

  useEffect(() => {
    if (!device || !selectedId) return;
    const requestScope = authScope.current;
    const buffer = eventBuffer.current ?? (eventBuffer.current = new MobileEventBuffer(selectedId));
    if (buffer.setSession(selectedId)) patchSessionView(selectedId, (current) => ({ ...current, events: [] }));
    const controller = new AbortController();
    let alive = true;
    let retryDelay = 500;
    let retryTimer: number | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    patchSessionView(selectedId, (current) => ({ ...current, streamConnected: false }));

    const connect = async (): Promise<void> => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const cursor = buffer.requestCursor;
        reader = await openEventStream(selectedId, cursor.after, cursor.epoch, csrf, controller.signal);
        activeReader = reader;
        if (!alive) { await reader.cancel(); return; }
        retryDelay = 500;
        patchSessionView(selectedId, (current) => ({ ...current, streamConnected: true }));
        const result = await consumeMobileEventStream(reader, buffer, {
          onEpochChanged: () => {
            if (!alive) return;
            patchSessionView(selectedId, (current) => ({ ...current, events: buffer.events }));
            void syncSessionState(selectedId);
          },
          onSyncRequired: () => { if (alive) void syncSessionState(selectedId); },
          onEvent: (event) => {
            if (!alive) return;
            liveEventRevision.current++;
            patchSessionView(selectedId, (current) => ({ ...current, events: buffer.events }));
            if (event.kind === "approval" && event.approval) {
              patchSessionView(selectedId, (current) => ({ ...current, pendingApproval: event.approval, approvalOpen: true }));
            } else if (event.kind === "elicitation") {
              void readElicitations(selectedId).then((value) => {
                if (!alive) return;
                patchSessionView(selectedId, (current) => ({ ...current, pendingElicitation: value.elicitations[0], elicitationOpen: value.elicitations.length > 0 }));
              }).catch((cause: unknown) => { if (alive) handleApiError(cause, requestScope); });
            } else if (event.kind === "status" && event.status) {
              const busy = event.status === "working" || event.status === "approval";
              patchSessionView(selectedId, (current) => ({ ...current, activity: {
                busy, queue: current.activity?.queue ?? 0, images: current.activity?.images ?? [],
                liveStatus: event.status!, liveLabel: event.label ?? "Статус неизвестен",
              } }));
              if (!busy) {
                void readActivity(selectedId).then((value) => { if (alive) patchSessionView(selectedId, (current) => ({ ...current, activity: value })); })
                  .catch((cause: unknown) => { if (alive) handleApiError(cause, requestScope); });
                void refreshSnapshot();
              }
            }
          },
        }, controller.signal);
        if (result === "revoked") {
          if (alive && isCurrentMobileAuthScope(authScope.current, requestScope.generation, requestScope.deviceId)) expireSession();
          return;
        }
        throw new Error("Поток событий Codex закрылся");
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        patchSessionView(selectedId, (current) => ({ ...current, streamConnected: false }));
        if (cause instanceof MobileApiError && (cause.status === 401 || cause.status === 403)) {
          handleApiError(cause, requestScope);
          return;
        }
        retryTimer = window.setTimeout(() => { void connect(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      } finally {
        if (activeReader === reader) activeReader = undefined;
        reader?.releaseLock();
      }
    };

    void connect();
    return () => {
      alive = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller.abort();
      void activeReader?.cancel().catch(() => undefined);
    };
  }, [device, selectedId, csrf, expireSession, handleApiError, refreshSnapshot, patchSessionView]);

  const operation = useCallback(async <T,>(op: Parameters<typeof runOperation<T>>[0], args: Record<string, unknown>) => {
    setError("");
    const requestAuthGeneration = authScope.current.generation;
    const requestDeviceId = authScope.current.deviceId;
    try {
      const result = await runOperation<T>(op, args, csrf);
      if (!isCurrentMobileAuthScope(authScope.current, requestAuthGeneration, requestDeviceId)) {
        throw new DOMException("Операция отменена после смены устройства", "AbortError");
      }
      if (op === "create" || op === "forkThread" || op === "archiveThread" || op === "unarchiveThread" || op === "renameThread" || op === "deleteThread" || op === "createWorktree") {
        sessionPagesGeneration.current++;
        setSessionPages({});
        sessionPageRequests.current.clear();
      }
      if (!op.startsWith("terminal") && op !== "listMoreThreads" && op !== "searchThreads" && op !== "searchHistory" && op !== "updateThreadReadState") void refreshSnapshot();
      return result;
    } catch (cause) { handleApiError(cause, { generation: requestAuthGeneration, deviceId: requestDeviceId }); throw cause; }
  }, [csrf, handleApiError, refreshSnapshot]);

  async function syncSessionState(targetSessionId: string) {
    const requestGeneration = ++syncRequestGeneration.current;
    const selectionGeneration = sessionSelection.current.generation;
    const requestedSync = { sessionId: targetSessionId, selectionGeneration, requestGeneration };
    const eventRevision = liveEventRevision.current;
    const toolsSetting = includeToolsRef.current;
    const requestAuthGeneration = authScope.current.generation;
    const requestDeviceId = authScope.current.deviceId;
    const [historyResult, activityResult, queueResult, approvalResult, elicitationResult] = await Promise.allSettled([
      readHistory(targetSessionId, toolsSetting),
      readActivity(targetSessionId),
      runOperation<MobileQueue>("queue", { sessionId: targetSessionId }, csrf),
      readApprovals(targetSessionId),
      readElicitations(targetSessionId),
    ]);
    if (!isCurrentMobileSessionSync({
      sessionId: selectedIdRef.current,
      selectionGeneration: sessionSelection.current.generation,
      requestGeneration: syncRequestGeneration.current,
    }, requestedSync) ||
        !isCurrentMobileAuthScope(authScope.current, requestAuthGeneration, requestDeviceId)) return;
    const liveEventsArrived = liveEventRevision.current !== eventRevision;
    const historySettingStillMatches = includeToolsRef.current === toolsSetting;
    patchSessionView(targetSessionId, (current) => ({
      ...current,
      ...(historySettingStillMatches && historyResult.status === "fulfilled" ? { history: historyResult.value.entries } : {}),
      ...(!liveEventsArrived && activityResult.status === "fulfilled" ? { activity: activityResult.value } : {}),
      ...(!liveEventsArrived && queueResult.status === "fulfilled" ? { queue: queueResult.value } : {}),
      ...(!liveEventsArrived && approvalResult.status === "fulfilled" ? {
        pendingApproval: approvalResult.value.approvals[0],
        approvalOpen: approvalResult.value.approvals.length > 0,
      } : {}),
      ...(!liveEventsArrived && elicitationResult.status === "fulfilled" ? {
        pendingElicitation: elicitationResult.value.elicitations[0],
        elicitationOpen: elicitationResult.value.elicitations.length > 0,
      } : {}),
    }));
    const requestScope = { generation: requestAuthGeneration, deviceId: requestDeviceId };
    if (historySettingStillMatches && historyResult.status === "rejected") handleApiError(historyResult.reason, requestScope);
    if (!liveEventsArrived) {
      for (const result of [activityResult, queueResult, approvalResult, elicitationResult]) {
        if (result.status === "rejected") { handleApiError(result.reason, requestScope); break; }
      }
    }
    void refreshSnapshot();
  }

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
    if (page?.loaded && page.nextCursor === undefined) return;
    const cursor = page?.nextCursor ?? (!showArchived && !selectedProject ? snapshot.sessionsNextCursor : undefined);
    const requestToken = {};
    const requestGeneration = sessionPagesGeneration.current;
    sessionPageRequests.current.set(sessionPageKey, requestToken);
    setSessionPages((current) => ({ ...current, [sessionPageKey]: { ...(current[sessionPageKey] ?? { sessions: [], loaded: false }), loading: true } }));
    try {
      const result = await operation<{ sessions: MobileSession[]; nextCursor?: string }>("listMoreThreads", {
        ...(cursor ? { cursor } : {}), archived: showArchived, ...(selectedProject ? { cwd: selectedProject } : {}),
      });
      if (sessionPageRequests.current.get(sessionPageKey) !== requestToken || requestGeneration !== sessionPagesGeneration.current) return;
      setSessionPages((current) => {
        const previous = current[sessionPageKey] ?? { sessions: [], loaded: false, loading: false };
        const known = new Set([...baseProjectSessions, ...previous.sessions].map((session) => session.id));
        return {
          ...current,
          [sessionPageKey]: {
            sessions: [...previous.sessions, ...result.sessions.filter((session) => !known.has(session.id))],
            nextCursor: result.nextCursor,
            loaded: true,
            loading: false,
          },
        };
      });
    } catch {
      if (sessionPageRequests.current.get(sessionPageKey) === requestToken && requestGeneration === sessionPagesGeneration.current) {
        setSessionPages((current) => ({ ...current, [sessionPageKey]: { ...(current[sessionPageKey] ?? { sessions: [], loaded: false }), loading: false } }));
      }
    } finally {
      if (sessionPageRequests.current.get(sessionPageKey) === requestToken) sessionPageRequests.current.delete(sessionPageKey);
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
      setSessionViewState({ sessionId: "", value: emptySessionView() });
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
    const targetSessionId = selectedId;
    if (!targetSessionId) return;
    if (mode === "steer" && attachments.length) throw new Error("Файлы можно отправить в очередь, но не добавить к активному ходу");
    const payload = { sessionId: targetSessionId, text, images, attachments, mode, appIds };
    const fingerprint = mobileSendFingerprint(payload);
    const submissionLock = submissionLockFor(targetSessionId);
    if (!submissionLock.canRetryFingerprint(fingerprint)) {
      const cause = new Error("Результат предыдущей отправки неизвестен. Восстановите исходный текст, файлы и режим, затем повторите именно этот запрос.");
      setError(cause.message);
      throw cause;
    }
    const requestId = pendingSend.current.getOrCreate(fingerprint, () => crypto.randomUUID());
    const draftKey = mobileDraftKey(device?.id ?? "", draftScopeEpoch, targetSessionId);
    try {
      const result = await operation<{ result?: string; steered?: boolean }>(mode === "steer" ? "steer" : "send", {
        sessionId: targetSessionId, text, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
        attachmentIds: attachments.map((file) => file.id), appIds, requestId,
      });
      if (result?.result === "blocked") {
        throw new MobileApiError("Сеанс Codex не принял задание. Черновик и вложения сохранены; можно изменить запрос или повторить попытку.", 200, "rejected");
      }
      if (result?.result !== "ran" && result?.result !== "queued" && result?.result !== "held" && result?.steered !== true) {
        throw new Error("Сервер не подтвердил результат отправки. Сохраните черновик и повторите отправку, чтобы проверить прежний запрос.");
      }
      pendingSend.current.complete(fingerprint, requestId);
      setComposerDraftsBySession((current) => {
        const draft = current[draftKey];
        if (!draft) return current;
        const sentAttachmentIds = new Set(attachments.map((file) => file.id));
        const remainingImages = draft.images.filter((image) => !images.includes(image));
        const remainingAttachments = draft.attachments.filter((file) => !sentAttachmentIds.has(file.id));
        const sameApps = draft.appIds.length === appIds.length && draft.appIds.every((id, index) => id === appIds[index]);
        const nextAppIds = sameApps && draft.appIds.length > 0 ? [] : draft.appIds;
        const nextMode = draft.mode === mode ? "queue" : draft.mode;
        if (remainingImages.length === draft.images.length && remainingAttachments.length === draft.attachments.length &&
            nextAppIds === draft.appIds && nextMode === draft.mode) return current;
        return { ...current, [draftKey]: { ...draft, images: remainingImages, attachments: remainingAttachments, appIds: nextAppIds, mode: nextMode } };
      });
      setTimeout(() => { void refreshSnapshot(); }, 500);
    } catch (cause) {
      if (mobileSubmissionOutcome(cause) === "rejected") {
        pendingSend.current.complete(fingerprint, requestId);
        setError(cause instanceof Error ? cause.message : "Сервер подтвердил отказ до принятия задания.");
      } else {
        submissionLock.markUncertainSubmission(fingerprint);
        const detail = cause instanceof DOMException && cause.name === "AbortError"
          ? "Соединение прервано"
          : cause instanceof Error ? cause.message : "Не удалось связаться с Codex";
        setError(`${detail} Результат отправки неизвестен; повторите тот же запрос, чтобы проверить его без дублирования.`);
      }
      throw cause;
    }
  }

  async function loadEditableTurns(cursor?: string): Promise<MobileEditableTurns> {
    if (!selectedId) throw new Error("Сначала выберите сеанс Codex");
    return operation<MobileEditableTurns>("listEditableTurns", { sessionId: selectedId, ...(cursor ? { cursor } : {}) });
  }

  async function editAndRetry(turnId: string, text: string, expectedLatestTurnId: string) {
    const targetSession = selectedId;
    if (!targetSession) throw new Error("Сначала выберите сеанс Codex");
    await operation("editAndRetry", { sessionId: targetSession, turnId, expectedLatestTurnId, text, requestId: crypto.randomUUID() });
    const [nextHistory, nextActivity] = await Promise.all([readHistory(targetSession, includeTools), readActivity(targetSession)]);
    if (selectedIdRef.current === targetSession) {
      patchSessionView(targetSession, (current) => ({ ...current, history: nextHistory.entries, activity: nextActivity }));
    }
  }

  async function cancel() {
    if (!selectedId) return;
    await operation("cancel", { sessionId: selectedId }).catch(() => undefined);
    await readQueue();
  }

  async function readQueue() {
    const targetSessionId = selectedId;
    if (!targetSessionId || !connected) return;
    try {
      const nextQueue = await operation<MobileQueue>("queue", { sessionId: targetSessionId });
      patchSessionView(targetSessionId, (current) => ({ ...current, queue: nextQueue }));
    }
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
    const requestScope = authScope.current;
    try { await logout(csrf); }
    catch { /* The server may already have revoked this cookie. */ }
    if (isCurrentMobileAuthScope(authScope.current, requestScope.generation, requestScope.deviceId)) expireSession();
  }

  async function answerApproval(optionId: string) {
    const targetSessionId = selectedId;
    const approval = pendingApproval;
    if (!approval || !targetSessionId) return;
    const requestScope = authScope.current;
    try {
      await resolveApproval(approval.id, targetSessionId, optionId, csrf);
      patchSessionView(targetSessionId, (current) => ({ ...current, pendingApproval: undefined, approvalOpen: false }));
      setError("");
    } catch (cause) { handleApiError(cause, requestScope); throw cause; }
  }

  async function answerElicitation(action: MobileElicitationAction, content?: Record<string, unknown>) {
    const targetSessionId = selectedId;
    const elicitation = pendingElicitation;
    if (!elicitation || !targetSessionId) return;
    const requestScope = authScope.current;
    try {
      await resolveElicitation(elicitation.id, targetSessionId, action, content, csrf);
      patchSessionView(targetSessionId, (current) => ({ ...current, pendingElicitation: undefined, elicitationOpen: false }));
      setError("");
    } catch (cause) { handleApiError(cause, requestScope); throw cause; }
  }

  const onAuthenticated = useCallback((nextDevice: MobileDevice, nextCsrf: string) => {
    authScope.current = { generation: authScope.current.generation + 1, deviceId: nextDevice.id };
    snapshotRequest.current = undefined;
    setDraftsBySession({});
    setComposerDraftsBySession({});
    setDraftScopeEpoch((epoch) => epoch + 1);
    submissionLocks.current.clear();
    setSnapshot(undefined);
    setSelectedProject("");
    setSelectedId("");
    setDevice(nextDevice);
    setCsrf(nextCsrf);
    setError("");
  }, []);

  if (!device) {
    return <><Pairing onAuthenticated={onAuthenticated} />{error && <p className="fixed bottom-4 left-4 right-4 rounded-xl border border-[#733b39] bg-[#351f1e] p-3 text-sm text-[#ffc3bd]" role="alert">{error}</p>}</>;
  }

  if (!snapshot) return <main className="mobile-viewport flex items-center justify-center gap-3 text-sm text-muted"><LoaderCircle size={18} className="animate-spin text-accent" /> Подключаю Codex…</main>;

  return <div className="app-viewport safe-area-top flex flex-col overflow-hidden">
    <header className="relative z-20 flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-border bg-[#141815] px-3 sm:gap-3 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <Button id="workspace-toggle" variant="ghost" className="min-h-11 min-w-11 px-2 lg:hidden" aria-label="Открыть список сеансов" aria-controls="workspace-drawer" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(true)}><Menu size={20} /></Button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#46533d] bg-[#20291b] text-accent"><span className="font-mono text-sm font-bold">C</span></div>
        <div className="min-w-0"><p className="truncate text-sm font-bold tracking-tight">Codex Mobile</p><p className="hidden truncate text-[10px] text-muted sm:block">{snapshot.online ? "Локальный Codex runtime" : "Соединение с Codex потеряно"}</p></div>
      </div>
      <MobileHeaderActions
        streamConnected={streamConnected}
        refreshing={refreshing}
        canOpenProjectTools={Boolean(selectedId)}
        pendingApproval={Boolean(pendingApproval)}
        pendingElicitation={Boolean(pendingElicitation)}
        onRefresh={() => void refreshSnapshot(true)}
        onOpenApproval={() => patchSessionView(selectedId, (current) => ({ ...current, approvalOpen: true }))}
        onOpenElicitation={() => patchSessionView(selectedId, (current) => ({ ...current, elicitationOpen: true }))}
        onOpenFiles={() => setFilesOpen(true)}
        onOpenGit={() => { setGitReviewLocation(undefined); setGitOpen(true); }}
        onOpenTerminal={() => setTerminalOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDevices={() => setDevicesOpen(true)}
      />
    </header>
    <div className="flex min-h-0 flex-1">
      <Workspace snapshot={snapshot} selectedProject={selectedProject} search={search} searchResults={searchResults}
        searchCursor={searchCursor} searchLoading={searchLoading} searchMoreLoading={searchMoreLoading}
        extraSessions={currentSessionPage?.sessions ?? []} sessionsMoreLoading={currentSessionPage?.loading ?? false}
        sessionsHasMore={currentSessionPage?.loaded
          ? currentSessionPage.nextCursor !== undefined
          : showArchived ? Boolean(snapshot?.archiveAvailable) : Boolean(snapshot?.sessionsNextCursor)}
        onLoadMoreSessions={() => void loadMoreSessions()}
        showArchived={showArchived} onArchivedChange={setShowArchived} onLoadMore={() => void loadMoreSearch()} selectedId={selectedId}
        open={workspaceOpen} connectedIds={connectedIds} onProjectChange={setSelectedProject} onSearchChange={setSearch}
        onSelect={selectWorkspaceSession} onCreate={() => void createSession()} onClose={() => setWorkspaceOpen(false)}
        onArchive={archiveSession} onUnarchive={unarchiveSession} onRename={renameSession} onDelete={deleteSession}
        onCreateSection={createThreadSection} onRenameSection={renameThreadSection} onDeleteSection={deleteThreadSection}
        onMoveSession={moveSessionToSection} onUpdateReadState={updateSessionReadState} />
      <Conversation key={selectedId} session={selectedSession} draftText={draftsBySession[mobileDraftKey(device?.id ?? "", draftScopeEpoch, selectedId)] ?? ""}
        composerDraft={composerDraftsBySession[mobileDraftKey(device?.id ?? "", draftScopeEpoch, selectedId)] ?? emptyMobileComposerDraft()}
        submissionLock={submissionLockFor(selectedId)}
        onComposerDraftChange={updateComposerDraft}
        sessionSwitchNotice={sessionSwitchNotice}
        onDraftTextChange={(sessionId, text) => setDraftsBySession((current) => setSessionDraft(current, mobileDraftKey(device?.id ?? "", draftScopeEpoch, sessionId), text))}
        onClearDraft={(sessionId, sentText) => setDraftsBySession((current) => clearSessionDraftIfUnchanged(current, mobileDraftKey(device?.id ?? "", draftScopeEpoch, sessionId), sentText))}
        history={history} activity={activity} events={events} queue={queue}
        connected={connected} connecting={connecting} loading={loading} streamConnected={streamConnected}
        error={error} includeTools={includeTools} onToggleTools={() => setIncludeTools((value) => !value)}
        onConnect={() => void connectSession()} onCancel={() => void cancel()} onFork={() => void forkSession()} forking={forking}
        onCreateSideChat={() => void createSideChat()} sideChatting={sideChatting} onReturnToParent={() => void returnToParent()}
        onCompact={compactSession} compacting={compacting} onSend={send}
        onLoadSkills={loadMobileSkills}
        onLoadApps={loadMobileApps}
        onSearchHistory={(query, beforeOffset, revision) => operation<MobileHistorySearch>("searchHistory", { sessionId: selectedId, query, includeTools, ...(beforeOffset === undefined ? {} : { beforeOffset, revision }) })}
        onLoadOlderScreenshots={(sessionId, cursor) => operation<MobileScreenshotPage>("listOlderScreenshots", { sessionId, ...(cursor === undefined ? {} : { cursor }) })}
        onLoadEditableTurns={loadEditableTurns} onEditAndRetry={editAndRetry}
        onUploadAttachment={(sessionId, file) => uploadAttachment(sessionId, file, csrf)}
        onRemoveAttachment={(sessionId, id, keepalive) => removeAttachment(sessionId, id, csrf, keepalive)}
        onQueueRemove={(id) => void removeQueued(id)} onQueueResume={() => void resumeQueue()}
        onOpenReviewLocation={(location) => { if (!selectedId) return; setGitReviewLocation({ sessionId: selectedId, ...location }); setGitOpen(true); }}
        onQueueOpen={readQueue} />
    </div>
    {devicesOpen && <DevicePanel current={device} csrf={csrf} onClose={() => setDevicesOpen(false)} onLogout={() => { setDevicesOpen(false); expireSession(); }} onSignOut={() => void signOut()} />}
    {settingsOpen && <SettingsPanel sessionId={selectedId} connected={connected} csrf={csrf} onAccountChanged={() => void refreshSnapshot(true)} onClose={() => setSettingsOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {filesOpen && selectedId && <FilesPanel sessionId={selectedId} connected={connected} onClose={() => setFilesOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} />}
    {gitOpen && selectedId && <GitPanel key={selectedId} sessionId={selectedId} connected={connected} sessionBusy={selectedSession?.busy === true || activity?.busy === true || queue.busy} initialReviewLocation={gitReviewLocation?.sessionId === selectedId ? gitReviewLocation : undefined} onClose={() => { setGitOpen(false); setGitReviewLocation(undefined); }} onOperation={(op: MobileOperation, args) => operation(op, args)} onWorktreeCreated={async (id, path) => { await operation("select", { sessionId: id }); setSelectedSearchSession(undefined); setSelectedId(id); setSelectedProject(path); setGitOpen(false); setGitReviewLocation(undefined); setWorkspaceOpen(false); }} />}
    {terminalOpen && selectedId && selectedSession && <Suspense fallback={<div role="status" className="fixed inset-0 z-50 grid place-items-center bg-background text-sm text-muted">Открываю терминал…</div>}><TerminalPanel sessionId={selectedId} cwd={selectedSession.cwd} connected={connected} onClose={() => setTerminalOpen(false)} onOperation={(op: MobileOperation, args) => operation(op, args)} /></Suspense>}
    {approvalOpen && pendingApproval && <ApprovalPanel approval={pendingApproval} onResolve={answerApproval} onClose={() => patchSessionView(selectedId, (current) => ({ ...current, approvalOpen: false }))} />}
    {elicitationOpen && pendingElicitation && <ElicitationPanel elicitation={pendingElicitation} onResolve={answerElicitation} onClose={() => patchSessionView(selectedId, (current) => ({ ...current, elicitationOpen: false }))} />}
  </div>;
}
