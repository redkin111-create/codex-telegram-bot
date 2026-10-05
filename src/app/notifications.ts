import type { NotificationPreferences } from "./types.js";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  completion: true,
  approval: true,
  error: true,
  backgroundCompletion: true,
  progress: false,
  mode: "all",
};

export type NotificationPreset = "all" | "attention" | "quiet";
export type NotificationEvent = "approval" | "error" | "completion" | "backgroundCompletion" | "progress" | "retry" | "info";

/**
 * Decide only whether an already-visible Telegram message may make a sound.
 * Global quiet is a hard override; the per-chat preset controls sound without
 * hiding approvals or blocking errors.
 */
export function notificationShouldBeLoud(
  mode: NotificationPreferences["mode"],
  globalQuiet: boolean,
  event: NotificationEvent,
): boolean {
  if (globalQuiet || mode === "quiet" || event === "retry") return false;
  if (mode === "all" || mode === "custom") return true;
  return event === "approval" || event === "error";
}

export function notificationPreset(preset: NotificationPreset): NotificationPreferences {
  if (preset === "all") return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    completion: false,
    approval: true,
    error: true,
    backgroundCompletion: false,
    progress: false,
    mode: preset,
  };
}

export function notificationCompletionEnabled(
  foreground: boolean,
  preferences: NotificationPreferences,
  notifyOtherSessions: boolean,
): boolean {
  if (foreground) return preferences.completion;
  return notifyOtherSessions && preferences.backgroundCompletion;
}
