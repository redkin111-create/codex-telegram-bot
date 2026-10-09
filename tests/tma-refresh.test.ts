import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../src/tma/gateway.js";
import { readConversationHistory } from "../src/sessions/history.js";

function signed(token:string,userId:number):string{
  const args={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:userId})};
  const key=createHmac("sha256","WebAppData").update(token).digest();
  const hash=createHmac("sha256",key).update(Object.entries(args).map(([k,v])=>k+"="+v).sort().join("\n")).digest("hex");
  const params=new URLSearchParams(args);params.set("hash",hash);return params.toString();
}

test("local Mini App handles chat history while a slow snapshot is still running",async()=>{
  const token="101:fast-local-gateway";
  const secret="internal-token-with-at-least-32-chars";
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const operations:string[]=[];
  const server=startGateway({token,secret,owners:new Set(["101"]),port:0,host:"127.0.0.1"},async(job)=>{
    operations.push(job.op);
    if(job.op==="snapshot")await blocked;
    return {op:job.op,entries:job.op==="history"?[{role:"assistant",text:"New reply"}]:[]};
  });
  await once(server,"listening");
  const address=server.address();assert(address&&typeof address!=="string");
  const base="http://127.0.0.1:"+address.port;
  const call=(op:string)=>fetch(base+"/api/execute",{method:"POST",headers:{
    "Content-Type":"application/json","X-Telegram-Init-Data":signed(token,101),
  },body:JSON.stringify({op,args:{}})});
  try{
    const snapshot=call("snapshot");
    for(let n=0;n<100&&!operations.includes("snapshot");n++)await new Promise(r=>setTimeout(r,5));
    assert(operations.includes("snapshot"));
    const history=await Promise.race([
      call("history"),
      new Promise<never>((_r,reject)=>setTimeout(()=>reject(new Error("History blocked by snapshot")),1200)),
    ]);
    assert.equal(history.status,200);
    const payload=await history.json() as {data:{entries:Array<{text:string}>}};
    assert.equal(payload.data.entries[0]?.text,"New reply");
    release();
    assert.equal((await snapshot).status,200);
  }finally{
    release();
    server.closeAllConnections();
    await new Promise<void>(r=>server.close(()=>r()));
  }
});

test("conversation history reads past more than 4 MiB of tool output",()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-history-window-"));
  try{
    const file=join(dir,"rollout.jsonl");
    const assistant=(text:string)=>JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text}]}});
    const tool=JSON.stringify({type:"response_item",payload:{type:"function_call_output",output:"X".repeat(5*1024*1024)}});
    writeFileSync(file,assistant("REPORT_BEFORE_LONG_TOOL")+"\n"+tool+"\n"+assistant("LATEST_COMPLETE_REPORT")+"\n");
    const items=readConversationHistory(file,20);
    assert.deepEqual(items.map(x=>x.text),["REPORT_BEFORE_LONG_TOOL","LATEST_COMPLETE_REPORT"]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
