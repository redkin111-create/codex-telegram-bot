import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile skill inventory retains disabled state without dropping server paths internally", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const skills = [
    { name: "review", description: "Review changes", path: "C:\\private\\skills\\review\\SKILL.md", scope: "user", enabled: true },
    { name: "disabled-helper", description: "Disabled", path: "C:\\private\\skills\\disabled\\SKILL.md", scope: "repo", enabled: false },
    { name: "managed", description: "Managed", path: "C:\\private\\managed\\SKILL.md", scope: "admin", enabled: true },
  ];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "skills/list") return { data: [{ cwd: "C:\\work\\repo", skills, errors: [] }] };
    if (method === "skills/config/write") return { effectiveEnabled: true };
    throw new Error(`Unexpected Codex method: ${method}`);
  };

  const api = client as unknown as {
    listMobileSkills?: (cwd: string) => Promise<typeof skills>;
    setMobileSkillEnabled?: (name: string, enabled: boolean, cwd: string) => Promise<boolean>;
  };
  assert.equal(typeof api.listMobileSkills, "function");
  assert.equal(typeof api.setMobileSkillEnabled, "function");
  assert.deepEqual(await api.listMobileSkills!.call(client, "C:\\work\\repo"), skills);
  assert.deepEqual(calls[0], {
    method: "skills/list",
    params: { cwds: ["C:\\work\\repo"], forceReload: true },
  });

  assert.equal(await api.setMobileSkillEnabled!.call(client, "review", false, "C:\\work\\repo"), true,
    "the returned state must reflect Codex's effective setting, not the requested value");
  assert.deepEqual(calls.slice(1), [
    { method: "skills/list", params: { cwds: ["C:\\work\\repo"], forceReload: true } },
    { method: "skills/config/write", params: { name: "review", enabled: false } },
  ]);
});

test("mobile skill updates reject managed, unknown, and ambiguous skills before writing config", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let writes = 0;
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method) => {
    if (method === "skills/list") return { data: [{ skills: [
      { name: "managed", path: "C:\\managed\\SKILL.md", scope: "admin", enabled: true },
      { name: "duplicate", path: "C:\\one\\SKILL.md", scope: "user", enabled: true },
      { name: "duplicate", path: "C:\\two\\SKILL.md", scope: "repo", enabled: true },
    ] }] };
    if (method === "skills/config/write") { writes++; return { effectiveEnabled: true }; }
    throw new Error(`Unexpected Codex method: ${method}`);
  };
  const api = client as unknown as { setMobileSkillEnabled: (name: string, enabled: boolean, cwd: string) => Promise<boolean> };

  await assert.rejects(api.setMobileSkillEnabled.call(client, "managed", false, "C:\\work\\repo"), /управляется|нельзя менять/i);
  await assert.rejects(api.setMobileSkillEnabled.call(client, "missing", false, "C:\\work\\repo"), /не найден/i);
  await assert.rejects(api.setMobileSkillEnabled.call(client, "duplicate", false, "C:\\work\\repo"), /однозначно/i);
  assert.equal(writes, 0);
});
