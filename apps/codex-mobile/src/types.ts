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
}

export interface MobileSnapshot {
  projects: MobileProject[];
  sessions: MobileSession[];
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
  skills: Array<{ name: string; description?: string }>;
  mcpServers: Array<{ name: string; toolCount: number }>;
  account?: { type: string; email?: string; plan?: string };
  limits: Array<{ id: string; name: string; primary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number }; secondary?: { usedPercent: number; windowDurationMins?: number; resetsAt?: number } }>;
  subagents: Array<{ id: string; name: string; status: string }>;
  checkedAt: number;
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
  clean: boolean;
  changes: Array<{ code: string; path: string }>;
  checkedAt: number;
}

export interface MobileGitDiff {
  project: string;
  unstaged: string;
  staged: string;
  checkedAt: number;
}

export type MobileOperation = "create" | "select" | "send" | "cancel" | "queue" | "queueRemove" | "queueResume" | "setModel" | "setMode" | "setReasoning" | "writeFile" | "createFile";
