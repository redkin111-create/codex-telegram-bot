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
  const suffix=`${process.pid}-${Date.now()}`;
  const browserImage=join(tmpdir(),`bsk-screenshot-${suffix}.png`);
  const unrelatedTempImage=join(tmpdir(),`private-${suffix}.png`);
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
    }) as unknown as AcpClient;
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

    writeFileSync(unrelatedTempImage,screenshot);
    appendFileSync(file,record(unrelatedTempImage));
    const afterUnrelated=await agent.execute(job("activity"),[],{surface:"mobile"}) as {images:Array<{path:string}>};
    assert.equal(afterUnrelated.images.some(image=>image.path===unrelatedTempImage),false);
    await assert.rejects(agent.execute(job("image",{path:unrelatedTempImage}),[],{surface:"mobile"}),/Изображение не относится/);

    appendFileSync(file,record(browserImage));
    writeFileSync(browserImage,screenshot);
    const telegramImages=await agent.execute(job("activity")) as {images:Array<{path:string}>};
    assert.equal(telegramImages.images.some(image=>image.path===browserImage),false,"Telegram Mini App keeps its project-only image policy");
    await assert.rejects(agent.execute(job("image",{path:browserImage})),/Изображение не относится/);
    const browserImages=await agent.execute(job("activity"),[],{surface:"mobile"}) as {images:Array<{path:string}>};
    assert.equal(browserImages.images.at(-1)?.path,browserImage);
    const browserLoaded=await agent.execute(job("image",{path:browserImage}),[],{surface:"mobile"}) as {mime:string;data:string};
    assert.equal(browserLoaded.mime,"image/png");
    assert.deepEqual(Buffer.from(browserLoaded.data,"base64"),screenshot);
    agent.stop();
  }finally{
    rmSync(dir,{recursive:true,force:true});
    rmSync(browserImage,{force:true});
    rmSync(unrelatedTempImage,{force:true});
  }
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
    assert.deepEqual((await index.olderPage(sid,file,cwd)).images,[]);
  }finally{rmSync(cwd,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("image index exposes only real BSK screenshots from the system temp folder",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-bsk-screens-"));
  const suffix=`${process.pid}-${Date.now()}`;
  const browserScreenshot=join(tmpdir(),`bsk-screenshot-${suffix}.png`);
  const symlinkedBrowserScreenshot=join(tmpdir(),`bsk-screenshot-link-${suffix}.png`);
  const unrelatedImage=join(tmpdir(),`private-${suffix}.png`);
  const spoofedBrowserScreenshot=join(tmpdir(),`bsk-screenshot-spoof-${suffix}.png`);
  try{
    const cwd=join(dir,"workspace");
    mkdirSync(cwd);
    const file=join(dir,"rollout.jsonl");
    writeFileSync(browserScreenshot,screenshot);
    writeFileSync(unrelatedImage,screenshot);
    writeFileSync(spoofedBrowserScreenshot,Buffer.from("not a PNG image"));
    let symlinkCreated=false;
    try{symlinkSync(browserScreenshot,symlinkedBrowserScreenshot);symlinkCreated=true;}catch{/* symlink privilege absent on Windows CI */}
    writeFileSync(file,record(browserScreenshot)+record(unrelatedImage)+record(spoofedBrowserScreenshot)+
      (symlinkCreated?record(symlinkedBrowserScreenshot):""));

    const index=new TmaScreenshotIndex();
    assert.deepEqual(await index.scan(sid,file,cwd),[]);
    const images=await index.scan(sid,file,cwd,true);
    assert.deepEqual(images.map(image=>image.path),[browserScreenshot]);
    assert.deepEqual(await index.authorized(sid,file,cwd,browserScreenshot,true),images[0]);
    assert.equal(await index.authorized(sid,file,cwd,unrelatedImage,true),undefined);
    assert.equal(await index.authorized(sid,file,cwd,spoofedBrowserScreenshot,true),undefined);
    if(symlinkCreated)assert.equal(await index.authorized(sid,file,cwd,symlinkedBrowserScreenshot,true),undefined);
  }finally{
    rmSync(dir,{recursive:true,force:true});
    rmSync(browserScreenshot,{force:true});
    rmSync(symlinkedBrowserScreenshot,{force:true});
    rmSync(unrelatedImage,{force:true});
    rmSync(spoofedBrowserScreenshot,{force:true});
  }
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

test("screenshot index deduplicates equivalent paths with repeated separators",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-duplicate-screen-paths-"));
  try{
    const cwd=join(dir,"toy");
    mkdirSync(cwd);
    const image=join(cwd,"capture.png");
    const equivalent=process.platform==="win32"
      ? image.replaceAll("\\","\\\\")
      : image.replaceAll("/","//");
    const file=join(dir,"rollout.jsonl");
    writeFileSync(image,screenshot);
    writeFileSync(file,record(image)+record(equivalent));

    const index=new TmaScreenshotIndex();
    const recent=await index.scan(sid,file,cwd);
    assert.equal(recent.length,1,"one physical screenshot should produce one gallery entry");
    assert.deepEqual((await index.olderPage(sid,file,cwd)).images,[],
      "the equivalent older reference should not reappear on a history page");
    assert.deepEqual(await index.authorized(sid,file,cwd,equivalent),recent[0],
      "authorization should accept an equivalent path for the same validated screenshot");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("screenshot index returns every tracked image when a session has more than one screenful",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-many-screens-"));
  try{
    const cwd=join(dir,"toy");
    mkdirSync(cwd);
    const file=join(dir,"rollout.jsonl");
    const lines:string[]=[];
    for(let n=1;n<=30;n++){
      const path=join(cwd,`capture-${String(n).padStart(2,"0")}.png`);
      writeFileSync(path,screenshot);
      lines.push(record(path));
    }
    writeFileSync(file,lines.join(""));
    const index=new TmaScreenshotIndex();
    const images=await index.scan(sid,file,cwd);
    assert.equal(images.length,30);
    assert.equal(images[0]?.name,"capture-01.png");
    assert.equal(images.at(-1)?.name,"capture-30.png");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("screenshot index includes old screenshots before more than 8 MiB of later tool output",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-old-screenshot-window-"));
  try{
    const cwd=join(dir,"toy");
    mkdirSync(cwd);
    const file=join(dir,"rollout.jsonl");
    const image=join(cwd,"first-screen.png");
    writeFileSync(image,screenshot);
    writeFileSync(file,record(image));
    for(let n=0;n<3;n++){
      appendFileSync(file,JSON.stringify({type:"response_item",payload:{type:"function_call_output",
        output:"X".repeat(3*1024*1024)}})+"\n");
    }
    const index=new TmaScreenshotIndex();
    const images=await index.scan(sid,file,cwd);
    assert.equal(images.length,1);
    assert.equal(images[0]?.name,"first-screen.png");
    const laterImage=join(cwd,"later-screen.png");
    writeFileSync(laterImage,screenshot);
    appendFileSync(file,record(laterImage));
    const later=await index.scan(sid,file,cwd);
    assert.deepEqual(later.map((image)=>image.name),["first-screen.png","later-screen.png"]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("screenshot index keeps references beyond the previous 64-image cap",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-many-screens-over-cap-"));
  try{
    const cwd=join(dir,"toy");
    mkdirSync(cwd);
    const file=join(dir,"rollout.jsonl");
    const lines:string[]=[];
    for(let n=1;n<=80;n++){
      const path=join(cwd,`capture-${String(n).padStart(3,"0")}.png`);
      writeFileSync(path,screenshot);
      lines.push(record(path));
    }
    writeFileSync(file,lines.join(""));
    const index=new TmaScreenshotIndex();
    const images=await index.scan(sid,file,cwd);
    assert.equal(images.length,80);
    assert.equal(images[0]?.name,"capture-001.png");
    assert.equal(images.at(-1)?.name,"capture-080.png");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("older screenshot pages include every image beyond the recent 256-image window",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-screenshot-pages-"));
  try{
    const cwd=join(dir,"toy");
    mkdirSync(cwd);
    const file=join(dir,"rollout.jsonl");
    const lines:string[]=[];
    for(let n=1;n<=400;n++){
      const path=join(cwd,`capture-${String(n).padStart(3,"0")}.png`);
      writeFileSync(path,screenshot);
      lines.push(record(path));
    }
    writeFileSync(file,lines.join(""));
    const index=new TmaScreenshotIndex();
    const recent=await index.scan(sid,file,cwd);
    assert.equal(recent.length,256);
    const older=[] as Awaited<ReturnType<TmaScreenshotIndex["olderPage"]>>["images"];
    let cursor:number|undefined;
    for(let page=0;page<5;page++){
      const result=await index.olderPage(sid,file,cwd,cursor);
      older.push(...result.images);
      cursor=result.nextCursor;
      if(cursor===undefined)break;
    }
    const all=new Map([...recent,...older].map((image)=>[image.path,image]));
    assert.equal(all.size,400);
    assert.equal(all.has(join(cwd,"capture-001.png")),true);
    assert.equal(all.has(join(cwd,"capture-400.png")),true);
    assert.equal(cursor,undefined,"all older pages should have a terminal cursor");
    await assert.rejects(index.olderPage(sid,file,cwd,-1),/указатель страницы скриншотов/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
