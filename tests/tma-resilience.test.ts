import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store.js";
import { readConversationHistoryAsync } from "../src/sessions/history.js";

test("unknown Desktop rollouts do not trigger a recursive tree scan every 4-second heartbeat",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-missing-session-"));
  const sid="01234567-89ab-7cde-8123-456789abcdef";
  try{
    const store=new SessionStore(dir);
    const internal=store as unknown as {
      scan:()=>unknown;
      missingUntil:Map<string,number>;
    };
    const original=internal.scan.bind(store);
    let scans=0;
    internal.scan=()=>{scans++;return original();};
    assert.match(store.jsonlPath(sid),new RegExp(sid));
    assert.match(store.jsonlPath(sid),new RegExp(sid));
    assert.equal(scans,1,"negative lookup must be cached briefly");

    mkdirSync(join(dir,"2026","10","09"),{recursive:true});
    const rollout=join(dir,"2026","10","09","rollout-2026-10-09-"+sid+".jsonl");
    writeFileSync(rollout,'{"type":"session_meta","payload":{"id":"'+sid+'","cwd":"C:/toy"}}\n');
    internal.missingUntil.set(sid,Date.now()-1);
    assert.equal(store.jsonlPath(sid),rollout);
    assert.equal(scans,2,"expired negative cache discovers the newly written rollout");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("async transcript reader keeps full reports across >6 MiB of tool output without blocking HTTP tick",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-async-history-"));
  try{
    const path=join(dir,"rollout.jsonl");
    const message=(text:string)=>JSON.stringify({type:"response_item",payload:{
      type:"message",role:"assistant",content:[{type:"output_text",text}],
    }});
    const tool=JSON.stringify({type:"response_item",payload:{
      type:"function_call_output",output:"x".repeat(7*1024*1024),
    }});
    writeFileSync(path,message("Начальный отчёт")+"\n"+tool+"\n"+message("Последний полный ответ")+"\n");
    let ticked=false;
    const promise=readConversationHistoryAsync(path,40);
    setTimeout(()=>{ticked=true;},0);
    const entries=await promise;
    assert.equal(ticked,true,"large log scan should yield to Node's event loop");
    assert.deepEqual(entries.map(x=>x.text),["Начальный отчёт","Последний полный ответ"]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
