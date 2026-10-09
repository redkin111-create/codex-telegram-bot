import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { verifyTelegramInitData, TmaAuthError } from "../src/tma/security.js";
import { isTmaJob, isTmaOperation } from "../src/tma/protocol.js";

const token="123456:telegram-bot-test-token";
const owners=new Set(["101"]);
function sign(fields:Record<string,string>):string {
  const entries=Object.entries(fields);
  const secret=createHmac("sha256","WebAppData").update(token).digest();
  const signature=createHmac("sha256",secret).update(
    entries.map(([k,v])=>k+"="+v).sort().join("\n"),
  ).digest("hex");
  const params=new URLSearchParams(fields);
  params.set("hash",signature);
  return params.toString();
}
test("Telegram Mini App initData HMAC validation allows only the owner",()=>{
  const now=1710000000;
  const auth=sign({auth_date:String(now),user:JSON.stringify({id:101,first_name:"User"})});
  assert.equal(verifyTelegramInitData(auth,token,owners,now),101);
  assert.throws(()=>verifyTelegramInitData(auth,token,new Set(["202"]),now),TmaAuthError);
  assert.throws(()=>verifyTelegramInitData(auth,token,owners,now+3601),TmaAuthError);
  assert.throws(()=>verifyTelegramInitData(auth,token,owners,now-100),TmaAuthError);
  assert.throws(()=>verifyTelegramInitData(auth.replace("first_name","wrong_name"),token,owners,now),TmaAuthError);
});
test("Rejects initData with duplicate params and missing user",()=>{
  const now=1710000000;
  const auth=sign({auth_date:String(now),user:JSON.stringify({id:101})});
  assert.throws(()=>verifyTelegramInitData(auth+"&user="+encodeURIComponent('{"id":101}'),token,owners,now),TmaAuthError);
  assert.throws(()=>verifyTelegramInitData(sign({auth_date:String(now)}),token,owners,now),TmaAuthError);
});
test("TMA jobs are constrained to allowlisted operations and safe IDs",()=>{
  assert(isTmaOperation("history"));
  assert(!isTmaOperation("shell"));
  assert(!isTmaJob({id:"z",op:"send",userId:101,args:{text:"hi"}}));
  assert(isTmaJob({id:"abcdef0123456789abcdef01",op:"send",userId:101,args:{text:"hi"}}));
});
