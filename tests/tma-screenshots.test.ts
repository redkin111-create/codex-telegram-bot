import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmaScreenshotIndex } from "../src/tma/screenshots.js";
import { MiniAppAgent } from "../src/tma/agent.js";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import type { TmaJob } from "../src/tma/protocol.js";

const sid="01234567-89ab-7cde-8123-456789abcdef";
const screenshot=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4,5,6,7,8,9]);
function record(path:string){
  return JSON.stringify({type:"response_item",payload:{type:"function_call_output",
    output:'Screenshot saved to "'+path+'"'}})+"\n";
}

test("screenshots appear during a running turn, survive >2MiB of later tools and remain accessible",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-live-screens-"));
  try{
    const home=join(dir,"sessions"),cwd=join(dir,"toy");
    mkdirSync(home);mkdirSync(cwd);
    const image=join(cwd,"capture 1.png");
    const file=join(home,"rollout-2026-10-10-"+sid+".jsonl");
    writeFileSync(file,JSON.stringify({type:"session_meta",payload:{id:sid,cwd}})+"\n");
    const cfg={token:"test:token",sessionsDir:home,dataDir:join(dir,"data"),workspace:cwd,
      projectRoots:[cwd],allowedUsers:new Set(["101"])} as AppConfig;
    const acp=Object.assign(new EventEmitter(),{
      listProjects:async()=>[{id:"project",name:"toy",roots:[cwd]}],
      listThreads:async()=>[{id:sid,cwd,name:"Working",source:"cli",recencyAt:1}],
      availableModels:[],currentModelId:"test",
    }) as AcpClient;
    const registry={controller:()=>({list:()=>[]}),runtimeForSession:()=>undefined,get:()=>({sessionId:sid})} as unknown as RuntimeRegistry;
    const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301","secret-with-more-than-thirty-two-characters");
    const job=(op:"activity"|"history"|"image",args:Record<string,unknown>={}):TmaJob=>
      ({id:"abcdef0123456789abcdef01",op,userId:101,args:{sessionId:sid,...args}});
    const first=await agent.execute(job("activity")) as {images:unknown[]};
    assert.equal(first.images.length,0);
    appendFileSync(file,record(image));
    const before=await agent.execute(job("activity")) as {images:unknown[]};
    assert.equal(before.images.length,0,"not-yet-saved screenshot reference must be remembered");
    writeFileSync(image,screenshot);
    const during=await agent.execute(job("activity")) as {images:Array<{path:string}>};
    assert.equal(during.images[0]?.path,image);
    // Legacy tail-only lookup lost this image after large tool output.
    appendFileSync(file,JSON.stringify({type:"response_item",payload:{
      type:"function_call_output",output:"X".repeat(3*1024*1024)}})+"\n");
    const later=await agent.execute(job("activity")) as {images:Array<{path:string}>};
    assert.equal(later.images[0]?.path,image);
    const history=await agent.execute(job("history")) as {images:Array<{path:string}>};
    assert.equal(history.images[0]?.path,image);
    const loaded=await agent.execute(job("image",{path:image})) as {mime:string;data:string};
    assert.equal(loaded.mime,"image/png");
    assert.deepEqual(Buffer.from(loaded.data,"base64"),screenshot);
    agent.stop();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("image index does not expose symlinks or absolute screenshots outside a workspace",async()=>{
  const cwd=mkdtempSync(join(tmpdir(),"tma-image-root-"));
  const outside=mkdtempSync(join(tmpdir(),"tma-image-outside-"));
  try{
    const file=join(cwd,"rollout.jsonl");
    const privateFile=join(outside,"private.png"),symlink=join(cwd,"alias.png");
    writeFileSync(privateFile,screenshot);
    try{symlinkSync(privateFile,symlink);}catch{ /* symlink privilege absent on Windows CI */ }
    writeFileSync(file,record(privateFile)+record(symlink));
    const index=new TmaScreenshotIndex();
    const result=await index.scan(sid,file,cwd);
    assert.deepEqual(result,[]);
    assert.equal(await index.authorized(sid,file,cwd,privateFile),undefined);
  }finally{rmSync(cwd,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("incremental index returns successive screenshots without requiring final assistant replies",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-incremental-screens-"));
  try{
    const file=join(dir,"rollout.jsonl");
    writeFileSync(file,"");
    const index=new TmaScreenshotIndex();
    for(let n=1;n<=3;n++){
      const path=join(dir,"screen-"+n+".png");
      writeFileSync(path,screenshot);
      appendFileSync(file,record(path));
      const frames=await index.scan(sid,file,dir);
      assert.equal(frames.length,n);
      assert.equal(frames.at(-1)?.path,path);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
