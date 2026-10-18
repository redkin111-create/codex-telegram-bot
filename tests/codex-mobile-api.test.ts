import assert from "node:assert/strict";
import test from "node:test";
import { asLiveEvent } from "../apps/codex-mobile/src/lib/live-event.js";

const sessionId="11111111-1111-4111-8111-111111111111";

test("mobile SSE parser accepts only bounded plan fields and leaves step markup as text",()=>{
  const event=asLiveEvent({id:7,event:"message",data:JSON.stringify({
    id:7,sessionId,kind:"plan",turnId:"turn-1",at:123,
    explanation:"План выполнения",
    plan:[
      {step:"Проверить проект",status:"completed"},
      {step:"Показать <img src=x onerror=alert(1)>",status:"inProgress"},
    ],
    privateAccountData:"MUST_NOT_LEAK",
  })});
  assert.deepEqual(event,{
    id:7,sessionId,kind:"plan",turnId:"turn-1",at:123,
    explanation:"План выполнения",
    plan:[
      {step:"Проверить проект",status:"completed"},
      {step:"Показать <img src=x onerror=alert(1)>",status:"inProgress"},
    ],
  });
});

test("mobile SSE parser rejects malformed or oversized plan events",()=>{
  const event=(plan:unknown,explanation="")=>asLiveEvent({id:8,event:"message",data:JSON.stringify({
    id:8,sessionId,kind:"plan",at:123,explanation,plan,
  })});
  assert.equal(event([{step:"Шаг",status:"future-status"}]),undefined);
  assert.equal(event([{step:" ",status:"pending"}]),undefined);
  assert.equal(event(Array.from({length:31},(_,index)=>({step:`Шаг ${index}`,status:"pending"}))),undefined);
  assert.equal(event([{step:"Шаг",status:"pending"}],"x".repeat(1001)),undefined);
});

test("mobile SSE parser accepts only the fixed context-compaction confirmation",()=>{
  const event=(label:string)=>asLiveEvent({id:9,event:"message",data:JSON.stringify({
    id:9,sessionId,kind:"compaction",label,at:124,privateData:"MUST_NOT_LEAK",
  })});
  assert.deepEqual(event("Codex подтвердил сокращение контекста"),{
    id:9,sessionId,kind:"compaction",label:"Codex подтвердил сокращение контекста",at:124,
  });
  assert.equal(event("Выполнено <img src=x onerror=alert(1)>"),undefined);
});

test("mobile SSE exposes only an MCP elicitation signal, never its form values or callback URL",()=>{
  const event=asLiveEvent({id:10,event:"message",data:JSON.stringify({
    id:10,sessionId,kind:"elicitation",at:125,label:"MCP ждёт ответ",
    elicitation:{id:"55555555-5555-4555-8555-555555555555",url:"https://accounts.example/authorize?token=secret"},
    privateData:"MUST_NOT_LEAK",
  })});
  assert.deepEqual(event,{id:10,sessionId,kind:"elicitation",at:125,label:"MCP ждёт ответ"});
  const unsafe=asLiveEvent({id:11,event:"message",data:JSON.stringify({
    id:11,sessionId,kind:"elicitation",at:126,label:"Open <img onerror=alert(1)>",
  })});
  assert.equal(unsafe,undefined);
});
