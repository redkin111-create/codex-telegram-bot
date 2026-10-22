import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { ScreenshotRef } from "../apps/codex-mobile/src/types.js";
import type { ReactApi, ReactServerApi, ComponentType } from "../apps/codex-mobile/tests/react-types.js";

const appRequire = createRequire(new URL("../apps/codex-mobile/package.json", import.meta.url));
const React = appRequire("react") as ReactApi;
const { renderToStaticMarkup } = appRequire("react-dom/server") as ReactServerApi;
const { ScreenshotsGallery } = appRequire("./src/components/screenshots-gallery.tsx") as {
  ScreenshotsGallery: ComponentType<any>;
};
Object.assign(globalThis, { React, window: { location: { origin: "http://127.0.0.1" } } });

const fixtureImages: ScreenshotRef[] = Array.from({ length: 256 }, (_, index) => ({
  path: `C:\\fixture\\screenshots\\capture-${String(index + 145).padStart(3, "0")}.png`,
  name: `capture-${String(index + 145).padStart(3, "0")}.png`,
  mtimeMs: index + 145,
  size: 68,
}));

test("mobile screenshot gallery renders one page at a time", () => {
  const html = renderToStaticMarkup(React.createElement(ScreenshotsGallery, {
    sessionId: "11111111-1111-4111-8111-111111111111",
    images: fixtureImages,
    onLoadOlder: async () => ({ images: [] }),
    onOpenImage: () => undefined,
  }));

  assert.equal((html.match(/aria-label="Открыть скриншот/g) ?? []).length, 80);
  assert.match(html, /Показать более старые/);
  assert.doesNotMatch(html, /Показать более новые/);
});

test("mobile screenshot gallery collapses Windows paths that differ only by repeated separators", () => {
  const paths = [
    "C:/Users/Owner/Remote/capture.png",
    "C://Users//Owner//Remote//capture.png",
    "C:////Users////Owner////Remote////capture.png",
  ];
  const images = paths.map((path, index) => ({ path, name: "capture.png", mtimeMs: index, size: 68 }));
  const html = renderToStaticMarkup(React.createElement(ScreenshotsGallery, {
    sessionId: "11111111-1111-4111-8111-111111111111",
    images,
    onLoadOlder: async () => ({ images: [] }),
    onOpenImage: () => undefined,
  }));

  assert.equal((html.match(/aria-label="Открыть скриншот capture\.png"/g) ?? []).length, 1);
});
