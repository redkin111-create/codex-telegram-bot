import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { startGateway } from "../src/tma/gateway.js";
import { TmaLiveFeed } from "../src/tma/live.js";
import type { AcpClient } from "../src/acp/client.js";

const sid="01234567-89ab-7cde-8123-456789abcdef";
function signed(token:string):string{
  const args={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:101})};
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const hash=createHmac("sha256",secret).update(Object.entries(args)
    .map(([k,v])=>k+"="+v).sort().join("\n")).digest("hex");
  const data=new URLSearchParams(args);data.set("hash",hash);return data.toString();
}

test("SSE client with stale cursor from a previous bot restart receives replay and new epoch",async()=>{
  const token="123:replay-test",secret="another-secret-with-at-least-thirty-two-characters";
  const feed=new TmaLiveFeed(new EventEmitter() as AcpClient);
  feed.status(sid,"working","Running");
  const server=startGateway({token,secret,owners:new Set(["101"]),port:0,host:"127.0.0.1"},async()=>({}),{
    feed,authorize:async(_user,id)=>id===sid,connected:()=>false,
  });
  await once(server,"listening");
  const address=server.address();assert(address&&typeof address!=="string");
  const base="http://127.0.0.1:"+address.port;
  const ctl=new AbortController();
  try{
    const health=await fetch(base+"/api/health").then(r=>r.json()) as {
      online:boolean;codexConnected:boolean;serverTime:number;
    };
    assert.equal(health.online,true);
    assert.equal(health.codexConnected,false);
    assert(health.serverTime>0);
    const response=await fetch(base+"/api/stream",{method:"POST",signal:ctl.signal,headers:{
      "Content-Type":"application/json","X-Telegram-Init-Data":signed(token),
    },body:JSON.stringify({
      sessionId:sid,after:999999,epoch:"000000000000000000000000",
    })});
    assert.equal(response.status,200);
    const reader=response.body!.getReader(),decoder=new TextDecoder();
    let received="";
    for(let i=0;i<5&&!received.includes('"status":"working"');i++){
      const next=await Promise.race([
        reader.read(),
        new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error("SSE replay timeout")),1200)),
      ]);
      received+=decoder.decode(next.value);
    }
    assert.match(received,/event: hello/);
    assert(received.includes('"epoch":"'+feed.epoch+'"'));
    assert.match(received,/"status":"working"/,"old cursors must not hide new events after restart");
    await reader.cancel();
  }finally{
    ctl.abort();feed.dispose();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
