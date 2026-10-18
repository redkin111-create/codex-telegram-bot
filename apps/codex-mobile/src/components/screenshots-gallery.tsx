import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { imageUrl } from "../api.js";
import type { MobileScreenshotPage, ScreenshotRef } from "../types.js";
import { Button } from "./ui/primitives.js";

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
  const [olderImages, setOlderImages] = useState<ScreenshotRef[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const requestId = useRef(0);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;

  const allImages = useMemo(() => {
    const unique = new Map<string, ScreenshotRef>();
    for (const image of [...olderImages, ...images]) unique.set(image.path, image);
    return [...unique.values()].sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  }, [images, olderImages]);

  useEffect(() => {
    requestId.current++;
    loadingRef.current = false;
    setOlderImages([]);
    setCursor(undefined);
    setComplete(false);
    setLoading(false);
    setError("");
    return () => {
      requestId.current++;
      loadingRef.current = false;
    };
  }, [sessionId]);

  async function loadOlder() {
    if (loadingRef.current || complete) return;
    const targetSessionId = activeSessionId.current;
    const request = requestId.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await onLoadOlder(targetSessionId, cursor);
      if (request !== requestId.current || activeSessionId.current !== targetSessionId) return;
      setOlderImages((current) => {
        const seen = new Set(current.map((image) => image.path));
        return [...page.images.filter((image) => !seen.has(image.path)), ...current];
      });
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
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Скриншоты сеанса · {allImages.length}</h2>
      {!complete && <Button type="button" variant="outline" className="min-h-9 px-3 text-xs" onClick={() => void loadOlder()} disabled={loading}>
        {loading ? <LoaderCircle size={14} className="animate-spin" /> : null}{allImages.length ? "Показать более старые" : "Найти скриншоты"}
      </Button>}
      {complete && allImages.length > 0 && <span className="text-[11px] text-muted">Все доступные снимки загружены</span>}
    </div>
    {allImages.length > 0 ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{allImages.map((image) => <button type="button" key={image.path} onClick={() => onOpenImage({ path: image.path, name: image.name })} aria-label={"Открыть скриншот " + image.name} className="overflow-hidden rounded-xl border border-border bg-panel text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><img src={imageUrl(sessionId, image.path)} alt={image.name} loading="lazy" className="aspect-video w-full object-cover" /><span className="block truncate px-2 py-1.5 text-xs text-muted">{image.name}</span></button>)}</div> : complete ? <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">В этом сеансе скриншоты не найдены.</p> : null}
    {error && <p className="mt-2 rounded-xl border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]" role="alert">{error}</p>}
  </section>;
}
