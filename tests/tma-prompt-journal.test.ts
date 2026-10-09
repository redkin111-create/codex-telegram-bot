import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurablePromptJournal } from "../src/tma/prompt-journal.js";

const id="101:01234567-89ab-7cde-8123-456789abcdef:req_0123456789abcd";
const fingerprint="a".repeat(64);
test("persisted completed TMA send is replayed after process recreation without original prompt",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-journal-"));
  try{
    const first=new DurablePromptJournal(dir);
    first.reserve(id,fingerprint);
    first.complete(id,{result:"queued"});
    const second=new DurablePromptJournal(dir);
    assert.deepEqual(second.lookup(id,fingerprint),{found:true,result:{result:"queued"}});
    assert.throws(()=>second.lookup(id,"b".repeat(64)),/другого содержимого/);
    const file=readFileSync(join(dir,"tma-prompt-journal.json"),"utf8");
    assert(!file.includes("Очень секретная задача"),"no prompt text on disk");
    assert.equal(second.summary().completed,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("crash between reserve and Codex acknowledgement is never automatically replayed",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-ambiguous-"));
  try{
    const processA=new DurablePromptJournal(dir);
    processA.reserve(id,fingerprint);
    const processB=new DurablePromptJournal(dir);
    assert.throws(()=>processB.lookup(id,fingerprint),/Статус предыдущей отправки неизвестен/);
    assert.equal(processB.summary().reserved,1);
    processB.uncertain(id);
    assert.throws(()=>new DurablePromptJournal(dir).lookup(id,fingerprint),/неизвестен/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("known pre-dispatch failure can retry the same request after Desktop releases the writer",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-before-dispatch-"));
  try{
    const journal=new DurablePromptJournal(dir);
    journal.reserve(id,fingerprint);
    journal.clearBeforeDispatch(id);
    assert.deepEqual(new DurablePromptJournal(dir).lookup(id,fingerprint),{found:false});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("corrupt journal blocks commands instead of silently losing idempotency",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-corrupt-"));
  try{
    writeFileSync(join(dir,"tma-prompt-journal.json"),"{not valid json");
    assert.throws(()=>new DurablePromptJournal(dir),/повреждён/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
