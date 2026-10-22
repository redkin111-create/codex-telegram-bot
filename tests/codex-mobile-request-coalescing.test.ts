import assert from "node:assert/strict";
import test from "node:test";
import * as singleFlight from "../apps/codex-mobile/src/single-flight.js";

test("overlapping Mobile snapshot refreshes share one request and allow a later refresh", async () => {
  const coalesce = Reflect.get(singleFlight, "coalesceInFlight") as (<T>(slot: { current?: Promise<T> }, run: () => Promise<T>) => Promise<T>) | undefined;
  assert.equal(typeof coalesce, "function");
  if (!coalesce) return;

  const slot: { current?: Promise<number> } = {};
  let calls = 0;
  let resolveFirst!: (value: number) => void;
  const first = coalesce(slot, () => {
    calls += 1;
    return new Promise<number>((resolve) => { resolveFirst = resolve; });
  });
  const overlap = coalesce(slot, async () => {
    calls += 1;
    return 2;
  });

  assert.strictEqual(overlap, first);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveFirst(1);
  assert.equal(await overlap, 1);

  const later = await coalesce(slot, async () => {
    calls += 1;
    return 3;
  });
  assert.equal(later, 3);
  assert.equal(calls, 2);
});
