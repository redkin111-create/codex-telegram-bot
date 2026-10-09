import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { startGateway } from "../src/tma/gateway.js";

function telegramData(token:string):string {
  const params={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:101,first_name:"owner"})};
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const hash=createHmac("sha256",secret).update(
    Object.entries(params).map(([k,v])=>k+"="+v).sort().join("\n"),
  ).digest("hex");
  const data=new URLSearchParams(params);data.set("hash",hash);return data.toString();
}

test("Gateway authorizes Telegram owner and relays an RPC to a connected local agent",async()=>{
  const token="123:bot-token";
  const secret="secret-with-at-least-thirty-two-characters-for-test";
  const server=startGateway({token,secret,owners:new Set(["101"]),port:0,host:"127.0.0.1"});
  await once(server,"listening");
  const addr=server.address();
  assert(addr&&typeof addr!=="string");
  const base="http://127.0.0.1:"+addr.port;
  try{
    const page=await fetch(base+"/");
    assert.equal(page.status,200);
    assert((await page.text()).includes("Codex Remote"));
    const noAuth=await fetch(base+"/api/execute",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({op:"snapshot",args:{}})});
    assert.equal(noAuth.status,401);
    const headers={"Content-Type":"application/json","X-Telegram-Init-Data":telegramData(token)};
    const unknown=await fetch(base+"/api/execute",{method:"POST",headers,body:JSON.stringify({op:"shell",args:{}})});
    assert.equal(unknown.status,400);
    const agentPoll=fetch(base+"/api/agent/next",{headers:{Authorization:"Bearer "+secret}});
    for(let i=0;i<80;i++){
      const status=await fetch(base+"/api/health").then(r=>r.json()) as {online:boolean};
      if(status.online)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const request=fetch(base+"/api/execute",{method:"POST",headers,body:JSON.stringify({op:"snapshot",args:{}})});
    const polled=await (await agentPoll).json() as {job:{id:string;op:string;userId:number}};
    assert.equal(polled.job.op,"snapshot");
    assert.equal(polled.job.userId,101);
    const rsp=await fetch(base+"/api/agent/result",{method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+secret},
      body:JSON.stringify({id:polled.job.id,ok:true,data:{projects:[{name:"toy"}]}})});
    assert.equal(rsp.status,200);
    const answer=await (await request).json() as {ok:boolean;data:{projects:Array<{name:string}>}};
    assert.equal(answer.ok,true);
    assert.equal(answer.data.projects[0]?.name,"toy");
  }finally{
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
