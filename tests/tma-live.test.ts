import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { startGateway } from "../src/tma/gateway.js";
import { TmaLiveFeed } from "../src/tma/live.js";
import type { AcpClient } from "../src/acp/client.js";

const sid="01234567-89ab-7cde-8123-456789abcdef";
function auth(token:string,userId:number):string{
  const fields={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:userId})};
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const hash=createHmac("sha256",secret).update(Object.entries(fields)
    .map(([k,v])=>k+"="+v).sort().join("\n")).digest("hex");
  const data=new URLSearchParams(fields);data.set("hash",hash);return data.toString();
}

test("live feed publishes safe tool names and confirmed turn/approval statuses",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;text?:string;status?:string;label?:string}>=[];
  const stop=feed.subscribe(sid,0,e=>received.push(e));
  try{
    acp.emit("notification","turn/started",{threadId:sid,turn:{id:"turn1",threadId:sid}});
    acp.emit("session-update",sid,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Готово."}});
    acp.emit("session-update",sid,{sessionUpdate:"tool_call",title:"Running tests",
      rawInput:{env:{PASSWORD:"NEVER_LEAK_THIS_PASSWORD"}}});
    feed.status(sid,"approval","Нужно разрешение");
    acp.emit("notification","turn/completed",{threadId:sid,turn:{id:"turn1",status:"completed"}});
    assert.deepEqual(received.map(e=>e.kind),["plan","status","text","tool","status","status"]);
    assert.deepEqual(received.filter(e=>e.kind==="status").map(e=>e.status),
      ["working","approval","completed"]);
    assert(!JSON.stringify(received).includes("NEVER_LEAK_THIS_PASSWORD"));
    const replay:number[]=[];
    const unsub=feed.subscribe(sid,3,e=>replay.push(e.id));
    assert.deepEqual(replay,[4,5,6]);unsub();
  }finally{stop();feed.dispose();}
});

test("live tool labels hide shell commands, search text and absolute workspace paths",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;label?:string}>=[];
  const stop=feed.subscribe(sid,0,event=>received.push(event));
  try{
    acp.emit("session-update",sid,{sessionUpdate:"tool_call",kind:"execute",status:"in_progress",
      title:"git push origin --token hidden-value",rawInput:{command:"git push origin --token hidden-value"}});
    acp.emit("session-update",sid,{sessionUpdate:"tool_call",kind:"edit",status:"in_progress",
      title:"Edit C:\\Users\\Private\\Project\\src\\main.ts",rawInput:{path:"C:\\Users\\Private\\Project\\src\\main.ts"},
      content_blocks:[{type:"diff",path:"C:\\Users\\Private\\Project\\src\\main.ts",unified:"-old private source\n+new private source"}]});
    acp.emit("session-update",sid,{sessionUpdate:"tool_call",kind:"fetch",status:"completed",
      title:"Web search: private customer name",rawInput:{query:"private customer name"}});
    acp.emit("session-update",sid,{sessionUpdate:"command_execution_started",rawInput:{command:"type C:\\private\\secrets.txt"}});
    assert.deepEqual(received.map(({kind,label})=>({kind,label})),[
      {kind:"tool",label:"Команда выполняется"},
      {kind:"tool",label:"Изменяется файл main.ts"},
      {kind:"tool",label:"Веб-поиск Codex завершён"},
      {kind:"tool",label:"Команда Codex выполняется"},
    ]);
    assert(!JSON.stringify(received).includes("hidden-value"));
    assert(!JSON.stringify(received).includes("Private"));
    assert(!JSON.stringify(received).includes("customer name"));
    assert(!JSON.stringify(received).includes("private source"));
  }finally{stop();feed.dispose();}
});

test("live feed reports MCP OAuth completion without forwarding provider errors",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;label?:string;sessionId?:string}>=[];
  const stop=feed.subscribe(sid,0,e=>received.push(e));
  try{
    acp.emit("notification","mcpServer/oauth/login/completed",{
      threadId:sid,name:"fixture-mcp",success:false,error:"SECRET_PROVIDER_ERROR",
    });
    acp.emit("notification","mcpServer/oauth/login/completed",{
      name:"another-server",success:true,
    });
    assert.equal(received.length,1);
    assert.deepEqual(received.map(({kind,label,sessionId})=>({kind,label,sessionId})),[{
      kind:"activity",label:"Вход в MCP-сервер fixture-mcp не выполнен",sessionId:sid,
    }]);
    assert(!JSON.stringify(received).includes("SECRET_PROVIDER_ERROR"));
  }finally{stop();feed.dispose();}
});

test("live feed publishes bounded current-turn plans without forwarding extra protocol fields",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;turnId?:string;explanation?:string;plan?:Array<{step:string;status:string}>}>=[];
  const stop=feed.subscribe(sid,0,e=>received.push(e));
  try{
    acp.emit("notification","turn/plan/updated",{
      threadId:sid,turnId:"turn-1",explanation:"Проверка и исправление",
      plan:[
        {step:"Проверить файлы",status:"completed"},
        {step:"Исправить <img src=x onerror=alert(1)>",status:"inProgress"},
        {step:"Запустить тесты",status:"future-status"},
      ],
      privateAccountData:"MUST_NOT_LEAK",
    });
    acp.emit("notification","turn/plan/updated",{
      turnId:"turn-without-thread",plan:[{step:"Не должно попасть в ленту",status:"pending"}],
    });
    assert.deepEqual(received.map(({kind,turnId,explanation,plan})=>({kind,turnId,explanation,plan})),[{
      kind:"plan",turnId:"turn-1",explanation:"Проверка и исправление",plan:[
        {step:"Проверить файлы",status:"completed"},
        {step:"Исправить <img src=x onerror=alert(1)>",status:"inProgress"},
        {step:"Запустить тесты",status:"pending"},
      ],
    }]);
    assert(!JSON.stringify(received).includes("MUST_NOT_LEAK"));
  }finally{stop();feed.dispose();}
});

test("live feed marks context compaction complete only for Codex's completed compaction item",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;label?:string}>=[];
  const stop=feed.subscribe(sid,0,event=>received.push(event));
  try{
    acp.emit("notification","item/started",{threadId:sid,item:{id:"compact-1",type:"contextCompaction",status:"inProgress"}});
    assert.equal(received.length,0);
    acp.emit("notification","item/completed",{threadId:sid,item:{id:"compact-1",type:"contextCompaction",status:"completed",privateData:"MUST_NOT_LEAK"}});
    assert.deepEqual(received.map(({kind,label})=>({kind,label})),[{kind:"compaction",label:"Codex подтвердил сокращение контекста"}]);
    assert(!JSON.stringify(received).includes("MUST_NOT_LEAK"));
  }finally{stop();feed.dispose();}
});

test("live feed bounds realtime transcripts and publishes generic connection endings",()=>{
  const acp=new EventEmitter() as AcpClient;
  const feed=new TmaLiveFeed(acp);
  const received:Array<{kind:string;role?:string;text?:string;label?:string}>=[];
  const stop=feed.subscribe(sid,0,e=>received.push(e));
  try{
    acp.emit("notification","thread/realtime/transcript/done",{threadId:sid,role:"user",text:"Проверь изменения"});
    acp.emit("notification","thread/realtime/transcript/done",{threadId:sid,role:"assistant",text:"Проверяю изменения"});
    acp.emit("notification","thread/realtime/transcript/done",{threadId:sid,role:"system",text:"internal"});
    acp.emit("notification","thread/realtime/transcript/done",{role:"assistant",text:"missing-thread"});
    acp.emit("notification","thread/realtime/started",{threadId:sid});
    acp.emit("notification","thread/realtime/closed",{threadId:sid,outcome:"ended"});
    acp.emit("notification","thread/realtime/error",{threadId:sid,message:"SECRET_PROVIDER_ERROR"});
    assert.deepEqual(received.filter(({kind})=>kind==="transcript").map(({kind,role,text})=>({kind,role,text})),[
      {kind:"transcript",role:"user",text:"Проверь изменения"},
      {kind:"transcript",role:"assistant",text:"Проверяю изменения"},
    ]);
    assert.deepEqual(received.slice(2).map(({kind,label})=>({kind,label})),[
      {kind:"activity",label:"Голосовой режим Codex подключён"},
      {kind:"activity",label:"Голосовой режим Codex завершён"},
      {kind:"activity",label:"Ошибка голосового соединения Codex"},
    ]);
    assert(!JSON.stringify(received).includes("SECRET_PROVIDER_ERROR"));
  }finally{stop();feed.dispose();}
});

test("POST event stream verifies Telegram authorization, session ownership and reconnect cursor",async()=>{
  const token="100:live-stream-token",secret="secure-agent-secret-more-than-thirty-two-characters";
  const feed=new TmaLiveFeed(new EventEmitter() as AcpClient);
  const server=startGateway({token,secret,owners:new Set(["101"]),port:0,host:"127.0.0.1"},
    async()=>({}),{feed,authorize:async(u,id)=>u===101&&id===sid});
  await once(server,"listening");
  const addr=server.address();assert(addr&&typeof addr!=="string");
  const base="http://127.0.0.1:"+addr.port;
  const controller=new AbortController();
  try{
    const forbidden=await fetch(base+"/api/stream",{method:"POST",headers:{
      "Content-Type":"application/json","X-Telegram-Init-Data":auth(token,102),
    },body:JSON.stringify({sessionId:sid})});
    assert.equal(forbidden.status,401);
    const denied=await fetch(base+"/api/stream",{method:"POST",headers:{
      "Content-Type":"application/json","X-Telegram-Init-Data":auth(token,101),
    },body:JSON.stringify({sessionId:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"})});
    assert.equal(denied.status,403);
    feed.status(sid,"working");
    const accepted=await fetch(base+"/api/stream",{method:"POST",signal:controller.signal,headers:{
      "Content-Type":"application/json","X-Telegram-Init-Data":auth(token,101),
    },body:JSON.stringify({sessionId:sid,after:0})});
    assert.equal(accepted.status,200);
    assert.equal(accepted.headers.get("content-type"),"text/event-stream; charset=utf-8");
    const reader=accepted.body!.getReader();
    const first=await reader.read();
    assert.match(new TextDecoder().decode(first.value),/connected|working/);
    feed.publish(sid,{kind:"text",text:"live update"});
    const next=await reader.read();
    assert.match(new TextDecoder().decode(next.value),/live update/);
    await reader.cancel();controller.abort();
  }finally{
    controller.abort();
    feed.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
