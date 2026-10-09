import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiniAppAgent } from "../src/tma/agent.js";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import type { TmaJob } from "../src/tma/protocol.js";

test("same prompt request ID is executed exactly once across simultaneous and repeated retries",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-idempotency-"));
  const sessionId="01234567-89ab-7cde-8123-456789abcdef";
  try{
    const acp=Object.assign(new EventEmitter(),{
      listProjects:async()=>[{id:"p",name:"toy",roots:[dir]}],
      listThreads:async()=>[{id:sessionId,cwd:dir,name:"Working thread",source:"cli",recencyAt:1}],
    }) as AcpClient;
    let submits=0;
    const controller={
      runtimeForSession:()=>({sessionId}),
      foreground:()=>({sessionId}),
    };
    const registry={
      controller:()=>controller,
      submitPrompt:async()=>{
        submits++;
        await new Promise<void>(resolve=>setTimeout(resolve,15));
        return {kind:"submitted",outcome:"ran"};
      },
    } as unknown as RuntimeRegistry;
    const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],
      allowedUsers:new Set(["101"])} as AppConfig;
    const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301",
      "shared-secret-more-than-thirty-two-characters");
    const job:TmaJob={id:"abcdef0123456789abcdef01",op:"send",userId:101,
      args:{sessionId,text:"Fix it",requestId:"client_0123456789abcdef"}};
    const [a,b]=await Promise.all([agent.execute(job),agent.execute(job)]);
    const c=await agent.execute(job);
    assert.deepEqual([a,b,c],[{result:"ran"},{result:"ran"},{result:"ran"}]);
    assert.equal(submits,1);
    await assert.rejects(()=>agent.execute({...job,args:{...job.args,text:"Different text"}}),
      /Нельзя переиспользовать/);
    agent.stop();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
