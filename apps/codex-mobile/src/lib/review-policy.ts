export function canStartCodexReview(connected: boolean, sessionBusy: boolean, actionBusy: boolean): boolean {
  return connected && !sessionBusy && !actionBusy;
}
