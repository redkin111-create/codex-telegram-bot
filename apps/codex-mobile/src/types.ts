export interface MobileDevice {
  id: string;
  ownerId: number;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface MobileProject { path: string; name: string; }

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
}

export interface MobileSnapshot {
  projects: MobileProject[];
  sessions: MobileSession[];
  archivedSessions?: MobileSession[];
  archiveAvailable?: boolean;
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

export interface MobileHistory {
  entries: HistoryEntry[];
  images: ScreenshotRef[];
  project: string;
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

export interface MobileLiveEvent {
  id: number;
  sessionId: string;
  kind: "text" | "tool" | "status" | "activity" | "approval";
  text?: string;
  label?: string;
  status?: LiveStatus;
  approval?: MobileApproval;
  at: number;
}

export interface MobileApproval {
  id: string;
  title: string;
  kind: string;
  summary?: string;
  options: Array<{ id: string; label: string }>;
}

export interface MobileCapabilities {
  online: boolean;
  model: string;
  mode: string;
  reasoning: string;
  models: Array<{ id: string; name: string; description?: string }>;
  modes: Array<{ id: string; name: string; description?: string }>;
  reasoningLevels: string[];
  skills: Array<{ name: string; description?: string; enabled: boolean; scope?: "user" | "repo" | "system" | "admin"; canToggle: boolean; invokable: boolean }>;
  mcpServers: Array<{ name: string; toolCount: number }>;
  plugins: Array<{ id: string; name: string; marketplace: string; description?: string; capabilities: string[]; sourceType?: "remote" | "local" | "git" | "npm"; installed: boolean; enabled: boolean; installable: boolean; installPolicy: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE" | "unknown"; availability: string; mustShowInstallationInterstitial: boolean }>;
  pluginCatalogAvailable: boolean;
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
  branches: string[];
  remoteBranches: string[];
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

export type MobileOperation = "create" | "select" | "send" | "cancel" | "queue" | "queueRemove" | "queueResume" | "setModel" | "setMode" | "setReasoning" | "setGoal" | "clearGoal" | "setSkillEnabled" | "steer" | "forkThread" | "compactThread" | "archiveThread" | "unarchiveThread" | "renameThread" | "installPlugin" | "uninstallPlugin" | "createWorktree" | "searchThreads" | "terminalExec" | "terminalStart" | "terminalRead" | "terminalInput" | "terminalResize" | "terminalStop" | "writeFile" | "createFile" | "gitStage" | "gitUnstage" | "gitCommit" | "gitCreateBranch" | "gitSwitchBranch" | "gitTrackRemoteBranch";
