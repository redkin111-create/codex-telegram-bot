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
import type { PromptInput } from "../src/app/types.js";

test("same prompt request ID is executed exactly once across simultaneous and repeated retries",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-idempotency-"));
  const sessionId="01234567-89ab-7cde-8123-456789abcdef";
  try{
    const acp=Object.assign(new EventEmitter(),{
      listProjects:async()=>[{id:"p",name:"toy",roots:[dir]}],
      listThreads:async()=>[{id:sessionId,cwd:dir,name:"Working thread",source:"cli",recencyAt:1}],
    }) as AcpClient;
    let submits=0;
    let submitted:PromptInput|undefined;
    const controller={
      runtimeForSession:()=>({sessionId}),
      foreground:()=>({sessionId}),
    };
    const registry={
      controller:()=>controller,
      submitPrompt:async(_chatId:number,input:PromptInput)=>{
        submits++;submitted=input;
        await new Promise<void>(resolve=>setTimeout(resolve,15));
        return {kind:"submitted",outcome:"ran"};
      },
    } as unknown as RuntimeRegistry;
    const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],
      allowedUsers:new Set(["101"])} as AppConfig;
    const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301",
      "shared-secret-more-than-thirty-two-characters");
    const photo=Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1,2,3,4,5]);
    const image={mimeType:"image/jpeg",data:photo.toString("base64")};
    const job:TmaJob={id:"abcdef0123456789abcdef01",op:"send",userId:101,
      args:{sessionId,text:"Fix it",images:[image],requestId:"client_0123456789abcdef"}};
    const [a,b]=await Promise.all([agent.execute(job),agent.execute(job)]);
    const c=await agent.execute(job);
    assert.deepEqual([a,b,c],[{result:"ran"},{result:"ran"},{result:"ran"}]);
    assert.equal(submits,1);
    assert.equal(submitted?.images.length,1);
    assert.equal(submitted?.images[0]?.mimeType,"image/jpeg");
    await assert.rejects(()=>agent.execute({...job,args:{...job.args,text:"Different text"}}),
      /Нельзя переиспользовать/);
    const edited=Buffer.from(photo);edited[15]=7;
    await assert.rejects(()=>agent.execute({...job,args:{
      ...job.args,images:[{mimeType:"image/jpeg",data:edited.toString("base64")}],
    }}),/Нельзя переиспользовать/);
    agent.stop();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
