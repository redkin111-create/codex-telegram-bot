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
