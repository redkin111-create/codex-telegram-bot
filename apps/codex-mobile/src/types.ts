export interface MobileDevice {
  id: string;
  ownerId: number;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface MobileAccount {
  id: string;
  label: string;
  email?: string;
  accountType?: string;
  savedAt: string;
  active: boolean;
}

export interface MobileAccountsSnapshot {
  loggedIn: boolean;
  activeAccountId?: string;
  activeLabel?: string;
  activeAccountType?: string;
  autoRotate: boolean;
  accounts: MobileAccount[];
  deviceLogin?: {
    status: "starting" | "pending" | "completed" | "failed" | "cancelled";
    startedAt: string;
    verificationUrl?: string;
    userCode?: string;
  };
}

export type MobileAccountAction =
  | { action: "saveCurrent" }
  | { action: "rename"; id: string; label: string }
  | { action: "forget"; id: string }
  | { action: "setAutoRotate"; enabled: boolean }
  | { action: "switch"; id: string }
  | { action: "startDeviceLogin" }
  | { action: "cancelDeviceLogin" };

export interface MobileProject { path: string; name: string; }

export interface MobileThreadSection { id: string; name: string; builtIn?: boolean; }

export type LiveStatus = "working" | "approval" | "completed" | "failed" | "cancelled" | "observing" | "unknown";

export interface MobileSession {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  source: string;
  busy: boolean;
  queue: number;
  progress?: number;
  liveStatus: LiveStatus;
  liveLabel: string;
  archived?: boolean;
  ephemeral?: boolean;
  parentThreadId?: string;
  section?: MobileThreadSection | null;
  readState?: {
    firstUnread: null | { type: "threadStart" } | { type: "turn"; turnId: string };
    revision: string;
  };
}

export interface MobileSnapshot {
  projects: MobileProject[];
  sessions: MobileSession[];
  sessionsNextCursor?: string;
  archivedSessions?: MobileSession[];
  archiveAvailable?: boolean;
  sections?: MobileThreadSection[];
  sectionsAvailable?: boolean;
  selected: string | null;
  controlled: Array<{ id: string; busy: boolean; queue: number; paused: boolean }>;
  models: Array<{ id: string; name: string }>;
  model: string;
  online: boolean;
}

export interface HistoryEntry {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  tool?: string;
  timestamp?: number;
}

export interface ScreenshotRef {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
}

export interface MobileScreenshotPage {
  images: ScreenshotRef[];
  nextCursor?: number;
}

export interface MobileHistory {
  entries: HistoryEntry[];
  images: ScreenshotRef[];
  project: string;
}

export interface MobileHistorySearch {
  entries: HistoryEntry[];
  total: number;
  skippedLargeRecords: number;
  startOffset: number;
  nextOffset?: number;
  revision: string;
}

export interface MobileActivity {
  busy: boolean;
  queue: number;
  images: ScreenshotRef[];
  liveStatus: LiveStatus;
  liveLabel: string;
}

export interface MobileQueue {
  items: Array<{ id: string; text: string }>;
  busy: boolean;
  paused: boolean;
}

export interface MobileBackgroundTerminal {
  itemId: string;
  processId: string;
}

export interface MobileEditableTurn {
  turnId: string;
  text: string;
  skillNames?: string[];
  appIds?: string[];
  attachmentCount?: number;
  editable: boolean;
  reason?: string;
}

export interface MobileEditableTurns {
  latestTurnId?: string;
  turns: MobileEditableTurn[];
  nextCursor?: string;
}

export interface MobileAttachment {
  id: string;
  name: string;
  size: number;
  kind: "text" | "document";
}

export interface MobileLiveEvent {
  id: number;
  sessionId: string;
  kind: "text" | "tool" | "status" | "activity" | "approval" | "elicitation" | "transcript" | "plan" | "compaction";
  text?: string;
  role?: "user" | "assistant";
  label?: string;
  status?: LiveStatus;
  approval?: MobileApproval;
  turnId?: string;
  explanation?: string;
  plan?: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  at: number;
}

export interface MobileElicitationField {
  name: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  description?: string;
  options?: string[];
  secret?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface MobileElicitation {
  id: string;
  serverName: string;
  message: string;
  mode: "form" | "url";
  fields?: MobileElicitationField[];
  url?: string;
  urlHost?: string;
}

export type MobileElicitationAction = "accept" | "decline" | "cancel";

export interface MobileApproval {
  id: string;
  title: string;
  kind: string;
  summary?: string;
  options: Array<{ id: string; label: string }>;
}

export interface MobileCapabilities {
  capabilitySection?: "core" | "skills" | "apps" | "plugins" | "mcp" | "all";
  online: boolean;
  model: string;
  mode: string;
  reasoning: string;
  models: Array<{ id: string; name: string; description?: string }>;
  modes: Array<{ id: string; name: string; description?: string }>;
  reasoningLevels: string[];
  skills: Array<{ name: string; description?: string; enabled: boolean; scope?: "user" | "repo" | "system" | "admin"; canToggle: boolean; invokable: boolean }>;
  mcpServersAvailable: boolean;
  mcpServers: Array<{
    name: string;
    status: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | "unknown";
    authStatus: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oauth";
    serverName?: string;
    serverVersion?: string;
    tools: Array<{ name: string; description?: string; inputSchema?: {
      type?: string; description?: string; required?: string[]; properties?: Record<string, unknown>;
      items?: Record<string, unknown>; enum?: Array<string | number | boolean | null>; additionalProperties?: boolean;
    } }>;
    resources?: Array<{ id: string; name: string; description?: string; mimeType?: string; parameters?: string[] }>;
    toolCount: number;
    resourceCount: number;
    resourceTemplateCount: number;
    discoveryFailed: boolean;
  }>;
  plugins: Array<{ id: string; name: string; marketplace: string; description?: string; capabilities: string[]; sourceType?: "remote" | "local" | "git" | "npm"; installed: boolean; enabled: boolean; canToggle: boolean; installable: boolean; installPolicy: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE" | "unknown"; availability: string; mustShowInstallationInterstitial: boolean }>;
  pluginCatalogAvailable: boolean;
  marketplaces: Array<{ name: string; pluginCount: number; installedPluginCount: number; manageable: boolean }>;
  apps: Array<{ id: string; name: string; description?: string; enabled: boolean; accessible: boolean; callable: boolean; installUrl?: string }>;
  appsAvailable: boolean;
  account?: { type: string; email?: string; plan?: string };
  limits: Array<{ id: string; name: string; primary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number }; secondary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number } }>;
  subagents: Array<{ id: string; name: string; status: string }>;
  goal?: MobileThreadGoal;
  goalAvailable?: boolean;
  checkedAt: number;
}

export interface MobileThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface MobileFileEntry {
  name: string;
  kind: "directory" | "file";
  size?: number;
  mtimeMs: number;
}

export interface MobileFileListing {
  project: string;
  path: string;
  entries: MobileFileEntry[];
  total: number;
  nextOffset?: number;
}

export interface MobileFile {
  project: string;
  path: string;
  text: string;
  size: number;
  sha256: string;
}

export interface MobileGitStatus {
  project: string;
  branch: string;
  upstream?: string;
  branches: string[];
  remoteBranches: string[];
  remotes: Array<{ name: string; fetchTargets: string[]; pushTargets: string[] }>;
  clean: boolean;
  changes: Array<{ code: string; indexStatus: string; worktreeStatus: string; path: string; previousPath?: string }>;
  checkedAt: number;
}

export interface MobileGitDiff {
  project: string;
  unstaged: string;
  staged: string;
  checkedAt: number;
}

export interface MobileGitConflictStages {
  project: string;
  path: string;
  base?: string;
  ours?: string;
  theirs?: string;
  binaryStages?: Array<"base" | "ours" | "theirs">;
  unsupportedStages?: Array<"base" | "ours" | "theirs">;
  worktreeSha256?: string | null;
}

export type MobileOperation = "create" | "select" | "send" | "cancel" | "queue" | "queueRemove" | "queueResume" | "listOlderScreenshots" | "listThreadReadStates" | "updateThreadReadState" | "listThreadSections" | "createThreadSection" | "renameThreadSection" | "deleteThreadSection" | "moveThreadToSection" | "setModel" | "setMode" | "setReasoning" | "setGoal" | "clearGoal" | "setSkillEnabled" | "listMcpConfig" | "addMcpConfigServer" | "setMcpConfigEnabled" | "removeMcpConfigServer" | "restartCodex" | "mcpOAuthLogin" | "callMcpTool" | "readMcpResource" | "steer" | "forkThread" | "createSideChat" | "compactThread" | "reviewThread" | "archiveThread" | "unarchiveThread" | "renameThread" | "deleteThread" | "installPlugin" | "uninstallPlugin" | "setPluginEnabled" | "addMarketplace" | "removeMarketplace" | "upgradeMarketplace" | "createWorktree" | "searchThreads" | "searchHistory" | "listMoreThreads" | "latestEditableTurn" | "listEditableTurns" | "editAndRetry" | "transcribeAudio" | "listRealtimeVoices" | "startRealtime" | "stopRealtime" | "terminalExec" | "listTerminalShells" | "terminalStart" | "terminalRead" | "terminalInput" | "terminalResize" | "terminalStop" | "listBackgroundTerminals" | "stopBackgroundTerminal" | "writeFile" | "createFile" | "createDirectory" | "renameProjectEntry" | "deleteProjectEntry" | "gitResolveConflictStage" | "gitStage" | "gitUnstage" | "gitCommit" | "gitCreateBranch" | "gitSwitchBranch" | "gitTrackRemoteBranch" | "gitFetch" | "gitPull" | "gitPush";

export interface MobileRealtimeVoices { voices: string[]; defaultVoice: string; }
