import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import { enabledLocalTma, startLocalTma } from "../src/tma/local.js";

function sign(token: string, userId: number): string {
  const args={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:userId})};
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const hash=createHmac("sha256",secret).update(Object.entries(args)
    .map(([k,v])=>k+"="+v).sort().join("\n")).digest("hex");
  const encoded=new URLSearchParams(args);
  encoded.set("hash",hash);
  return encoded.toString();
}

test("TMA_LOCAL enables same-service local mode only when explicitly requested",()=>{
  assert.equal(enabledLocalTma({}),false);
  assert.equal(enabledLocalTma({TMA_LOCAL:"true"}),true);
  assert.equal(enabledLocalTma({TMA_LOCAL:"YES"}),true);
  assert.equal(enabledLocalTma({TMA_LOCAL:"false"}),false);
});

test("Local bot service starts a localhost gateway and serves Codex sessions end-to-end",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-local-tma-"));
  const cwd=join(dir,"toy");
  const token="12345:local-tma-test-token";
  const cfg={
    token, allowedUsers:new Set(["101"]),dataDir:dir,sessionsDir:dir,
    workspace:cwd,projectRoots:[cwd],
  } as AppConfig;
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"toy",roots:[cwd],createdAt:10,updatedAt:10,recencyAt:10}],
    listThreads:async()=>[{id:"session-101",name:"Native Codex thread",cwd,source:"cli",createdAt:10,updatedAt:10,recencyAt:10}],
    availableModels:[],currentModelId:"test",
  }) as unknown as AcpClient;
  const runtime={sessionId:"session-101",isBusy:false,queueLength:0};
  const controller={
    list:()=>[{sessionId:"session-101",cwd,projectName:"toy",busy:false,queueLength:0,queuePaused:false}],
  };
  const registry={
    controller:()=>controller,
    get:()=>runtime,
  } as unknown as RuntimeRegistry;
  const svc=await startLocalTma(cfg,acp,registry,{port:0});
  try {
    assert(svc.origin.startsWith("http://127.0.0.1:"));
    for(let i=0;i<150;i++){
      const health=await fetch(svc.origin+"/api/health").then(x=>x.json()) as {online:boolean};
      if(health.online)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const health=await fetch(svc.origin+"/api/health").then(x=>x.json()) as {online:boolean};
    assert.equal(health.online,true,"the local agent must reach its own gateway");
    const bad=await fetch(svc.origin+"/api/execute",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({op:"snapshot",args:{}})});
    assert.equal(bad.status,401);
    const resp=await fetch(svc.origin+"/api/execute",{method:"POST",headers:{
      "Content-Type":"application/json","X-Telegram-Init-Data":sign(token,101),
    },body:JSON.stringify({op:"snapshot",args:{}})});
    assert.equal(resp.status,200);
    const data=await resp.json() as {ok:boolean;data:{projects:Array<{name:string}>,sessions:Array<{id:string}>}};
    assert.equal(data.ok,true);
    assert.equal(data.data.projects[0]?.name,"toy");
    assert.equal(data.data.sessions[0]?.id,"session-101");
  }finally{
    await svc.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
