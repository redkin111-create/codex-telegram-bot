/** Small helpers shared by phone-sized inline pickers. */

export const INLINE_PAGE_SIZE = 6;
export const TELEGRAM_CALLBACK_LIMIT_BYTES = 64;

export interface PageWindow {
  page: number;
  pages: number;
  start: number;
  end: number;
}

export function pageWindow(count: number, requestedPage: number, size = INLINE_PAGE_SIZE): PageWindow {
  const pages = Math.max(1, Math.ceil(Math.max(0, count) / size));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pages - 1);
  return { page, pages, start: page * size, end: Math.min(count, (page + 1) * size) };
}

/** Keep a display label on one line and avoid splitting emoji/surrogate pairs. */
export function compactLabel(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : clean;
}

export function callbackDataFits(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_LIMIT_BYTES;
}
