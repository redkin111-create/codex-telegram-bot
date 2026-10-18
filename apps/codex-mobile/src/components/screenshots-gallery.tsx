import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { imageUrl } from "../api.js";
import type { MobileScreenshotPage, ScreenshotRef } from "../types.js";
import { Button } from "./ui/primitives.js";

const SCREENSHOTS_PER_PAGE = 80;

export function ScreenshotsGallery({
  sessionId,
  images,
  onLoadOlder,
  onOpenImage,
}: {
  sessionId: string;
  images: ScreenshotRef[];
  onLoadOlder: (sessionId: string, beforeOffset?: number) => Promise<MobileScreenshotPage>;
  onOpenImage: (image: { path: string; name: string }) => void;
}) {
  const [olderPages, setOlderPages] = useState<ScreenshotRef[][]>([]);
  const [cursor, setCursor] = useState<number>();
  const [complete, setComplete] = useState(false);
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const requestId = useRef(0);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;

  const pages = useMemo(() => {
    const recent = new Map<string, ScreenshotRef>();
    for (const image of images) recent.set(image.path, image);
    const sorted = [...recent.values()].sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    const result: ScreenshotRef[][] = [];
    for (let end = sorted.length; end > 0; end -= SCREENSHOTS_PER_PAGE) {
      result.push(sorted.slice(Math.max(0, end - SCREENSHOTS_PER_PAGE), end));
    }
    const seen = new Set(recent.keys());
    for (const page of olderPages) {
      const unique = page.filter((image) => {
        if (seen.has(image.path)) return false;
        seen.add(image.path);
        return true;
      });
      if (unique.length) result.push(unique);
    }
    return result;
  }, [images, olderPages]);
  const imageCount = pages.reduce((count, page) => count + page.length, 0);
  const visibleImages = pages[pageOffset] ?? [];
  const hasNewer = pageOffset > 0;
  const hasOlder = pageOffset + 1 < pages.length || !complete;

  useEffect(() => {
    requestId.current++;
    loadingRef.current = false;
    setOlderPages([]);
    setCursor(undefined);
    setComplete(false);
    setPageOffset(0);
    setLoading(false);
    setError("");
    return () => {
      requestId.current++;
      loadingRef.current = false;
    };
  }, [sessionId]);

  function showNewer() {
    setPageOffset((current) => Math.max(0, current - 1));
  }

  async function showOlder() {
    if (loadingRef.current) return;
    if (pageOffset + 1 < pages.length) {
      setPageOffset((current) => current + 1);
      return;
    }
    if (complete) return;
    const targetSessionId = activeSessionId.current;
    const request = requestId.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await onLoadOlder(targetSessionId, cursor);
      if (request !== requestId.current || activeSessionId.current !== targetSessionId) return;
      const known = new Set([...images.map((image) => image.path), ...olderPages.flatMap((items) => items.map((image) => image.path))]);
      const unique = page.images.filter((image) => {
        if (known.has(image.path)) return false;
        known.add(image.path);
        return true;
      });
      if (unique.length) {
        setOlderPages((current) => [...current, unique]);
        setPageOffset((current) => current === 0 && pages.length === 0 ? 0 : current + 1);
      }
      setCursor(page.nextCursor);
      setComplete(page.nextCursor === undefined);
    } catch (cause) {
      if (request === requestId.current && activeSessionId.current === targetSessionId) {
        setError(cause instanceof Error ? cause.message : "Не удалось загрузить старые скриншоты");
      }
    } finally {
      if (request === requestId.current) {
        loadingRef.current = false;
        if (activeSessionId.current === targetSessionId) setLoading(false);
      }
    }
  }

  return <section className="mx-auto mt-6 max-w-4xl" aria-label="Скриншоты сеанса">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Скриншоты сеанса · {imageCount}</h2>
      <div className="flex flex-wrap gap-2">
        {hasNewer && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={showNewer} disabled={loading}>Показать более новые</Button>}
        {hasOlder && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={() => void showOlder()} disabled={loading}>
          {loading ? <LoaderCircle size={14} className="animate-spin" /> : null}{imageCount ? "Показать более старые" : "Найти скриншоты"}
        </Button>}
      </div>
    </div>
    {imageCount > 0 && <p className="mb-2 text-[11px] text-muted">Страница {pageOffset + 1} из {pages.length}{complete ? "" : "+"} · {visibleImages.length} снимков</p>}
    {visibleImages.length > 0 ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{visibleImages.map((image) => <button type="button" key={image.path} onClick={() => onOpenImage({ path: image.path, name: image.name })} aria-label={"Открыть скриншот " + image.name} className="overflow-hidden rounded-xl border border-border bg-panel text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><img src={imageUrl(sessionId, image.path)} alt={image.name} loading="lazy" className="aspect-video w-full object-cover" /><span className="block truncate px-2 py-1.5 text-xs text-muted">{image.name}</span></button>)}</div> : complete ? <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">В этом сеансе скриншоты не найдены.</p> : null}
    {complete && imageCount > 0 && <p className="mt-2 text-[11px] text-muted">Все доступные снимки загружены</p>}
    {error && <p className="mt-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]" role="alert">{error}</p>}
  </section>;
}
