import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiniAppAgent } from "../src/tma/agent.js";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

test("Windows Mini App agent lists existing Codex projects and sessions",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-tma-agent-"));
  const project=join(dir,"toy");
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"toy",roots:[project],createdAt:1,updatedAt:1,recencyAt:1}],
    listThreads:async()=>[{id:"session-a",name:"Yupland NFT work",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2}],
    availableModels:[{modelId:"test",name:"Test Model"}],
    currentModelId:"test",
  }) as unknown as AcpClient;
  const runtime={sessionId:"session-a",queueLength:0,isBusy:false};
  const controller={
    list:()=>[{sessionId:"session-a",cwd:project,projectName:"toy",busy:false,foreground:true,unread:0,queueLength:0,queuePaused:false,canClose:true}],
    runtimeForSession:()=>runtime,
    foreground:()=>runtime,
    addAttach:async()=>{throw new Error("should not attach for snapshot");},
  };
  const registry={controller:()=>controller,get:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301","secret-with-more-than-thirty-two-characters");
  try{
    const result=await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}}) as {
      projects:Array<{name:string;path:string}>;sessions:Array<{id:string;title:string}>;
      selected:string;online:boolean;
    };
    assert.equal(result.projects[0]?.name,"toy");
    assert.equal(result.projects[0]?.path,project);
    assert.equal(result.sessions[0]?.id,"session-a");
    assert.equal(result.selected,"session-a");
    assert.equal(result.online,true);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});
