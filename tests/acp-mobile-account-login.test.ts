import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile sign-in delegates device-code login and cancellation to the shared Codex app-server", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "account/login/start") return {
      type: "chatgptDeviceCode",
      loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    };
    return { status: "canceled" };
  };
  const api = client as unknown as {
    startChatgptDeviceCodeLogin?: () => Promise<{ loginId: string; verificationUrl: string; userCode: string }>;
    cancelAccountLogin?: (loginId: string) => Promise<void>;
  };
  assert.equal(typeof api.startChatgptDeviceCodeLogin, "function");
  assert.equal(typeof api.cancelAccountLogin, "function");
  assert.deepEqual(await api.startChatgptDeviceCodeLogin!.call(client), {
    loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
  await api.cancelAccountLogin!.call(client, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(calls, [
    { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
    { method: "account/login/cancel", params: { loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
  ]);
});

test("mobile device-code login rejects unsafe links, malformed codes and unknown start replies", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const api = client as unknown as { startChatgptDeviceCodeLogin: () => Promise<unknown> };
  const base = {
    type: "chatgptDeviceCode",
    loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  };
  for (const response of [
    { ...base, verificationUrl: "http://auth.openai.com/codex/device" },
    { ...base, verificationUrl: "https://attacker.example/codex/device" },
    { ...base, verificationUrl: "https://auth.openai.com/codex/device?next=https://attacker.example" },
    { ...base, userCode: "<script>alert(1)</script>" },
    { ...base, loginId: "not-a-uuid" },
    { ...base, type: "chatgpt" },
  ]) {
    internal.request = async () => response;
    await assert.rejects(api.startChatgptDeviceCodeLogin.call(client));
  }
});

test("mobile login cancellation accepts only a UUID from the tracked device-code flow", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let requests = 0;
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async () => { requests++; return {}; };
  const api = client as unknown as { cancelAccountLogin: (loginId: string) => Promise<void> };
  await assert.rejects(api.cancelAccountLogin.call(client, "../../login"), /ID входа/);
  assert.equal(requests, 0);
});
