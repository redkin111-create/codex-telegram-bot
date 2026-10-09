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
    assert.deepEqual(received.map(e=>e.kind),["status","text","tool","status","status"]);
    assert.deepEqual(received.filter(e=>e.kind==="status").map(e=>e.status),
      ["working","approval","completed"]);
    assert(!JSON.stringify(received).includes("NEVER_LEAK_THIS_PASSWORD"));
    const replay:number[]=[];
    const unsub=feed.subscribe(sid,3,e=>replay.push(e.id));
    assert.deepEqual(replay,[4,5]);unsub();
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
