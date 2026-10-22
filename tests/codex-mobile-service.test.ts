import assert from "node:assert/strict";
import test from "node:test";
import { codexMobileEnabled, mobileAllowedOrigins, mobilePort } from "../src/mobile/service.js";

test("mobile service stays disabled unless its own explicit opt-in is enabled", () => {
  assert.equal(codexMobileEnabled({}), false);
  assert.equal(codexMobileEnabled({ CODEX_MOBILE_ENABLED: "1" }), true);
  assert.equal(codexMobileEnabled({ CODEX_MOBILE_ENABLED: "false" }), false);
});

test("mobile listener gets its own port and refuses the Mini App port", () => {
  assert.equal(mobilePort({}), 3302);
  assert.equal(mobilePort({ CODEX_MOBILE_PORT: "4400", TMA_PORT: "3301" }), 4400);
  assert.throws(() => mobilePort({ CODEX_MOBILE_PORT: "3301" }), /separate/i);
  assert.throws(() => mobilePort({ CODEX_MOBILE_PORT: "4300", TMA_PORT: "4300" }), /separate/i);
  assert.throws(() => mobilePort({ CODEX_MOBILE_PORT: "not-a-port" }), /port/i);
});

test("configured browser origins are exact and HTTPS outside loopback", () => {
  assert.deepEqual(mobileAllowedOrigins({ CODEX_MOBILE_ORIGINS: "https://laptop.tailnet.test:8443" }), ["https://laptop.tailnet.test:8443"]);
  assert.throws(() => mobileAllowedOrigins({ CODEX_MOBILE_ORIGINS: "https://example.test/path" }), /origin/i);
  assert.throws(() => mobileAllowedOrigins({ CODEX_MOBILE_ORIGINS: "http://example.test" }), /https/i);
});
