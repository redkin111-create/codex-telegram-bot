import assert from "node:assert/strict";
import test from "node:test";
import { AccountRotatorImpl } from "../src/bot/account-rotator.js";

test("a device login can hold the shared account lock without switching accounts", async () => {
  const events: string[] = [];
  const rotator = new AccountRotatorImpl(
    {
      async activeBytes() { return Buffer.from("active-auth"); },
      async switchTo(id: string) { events.push(`switch:${id}`); return {}; },
      async restoreActive() { events.push("restore"); },
    } as never,
    { async restart() { events.push("restart"); } } as never,
    {} as never,
  );
  let release!: () => void;
  let entered!: () => void;
  const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
  const held = rotator.runLocked(async () => {
    events.push("login-start");
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
    events.push("login-end");
  });
  await enteredLock;
  const switched = rotator.runExclusive("saved-account-01", async () => { events.push("switch-operation"); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["login-start"], "account rotation must wait for the in-flight device login operation");
  release();
  await Promise.all([held, switched]);
  assert.deepEqual(events, ["login-start", "login-end", "switch:saved-account-01", "restart", "switch-operation"]);
});
