/**
 * VPS gateway: Telegram-authenticated HTTPS API with a reverse long-poll RPC
 * tunnel to the user's Windows bot. No Codex tokens/files are stored here.
 *
 * Run behind TLS reverse proxy; binds to 127.0.0.1 by default.
 */
import "dotenv/config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTmaOperation, type TmaJob, type TmaResult } from "./protocol.js";
import { verifyTelegramInitData } from "./security.js";

const home = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "mini-app", "public");
const pending = new Map<string, { userId:number; resolve:(v:TmaResult)=>void; timer:NodeJS.Timeout }>();
const waiting: TmaJob[] = [];
let poller: { finish:(job:TmaJob|null)=>void; timer:NodeJS.Timeout } | undefined;
let lastAgentAt = 0;

function required(name:string):string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

export interface GatewayConfig { token:string; secret:string; owners:Set<string>; port:number; host:string; }
export function gatewayConfig(): GatewayConfig {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("TMA_AGENT_TOKEN");
  if (secret.length < 32) throw new Error("TMA_AGENT_TOKEN must be at least 32 characters");
  const owners = new Set(required("TMA_OWNER_IDS").split(",").map(v=>v.trim()).filter(v=>/^[0-9]+$/.test(v)));
  if (!owners.size) throw new Error("TMA_OWNER_IDS must contain Telegram numeric user id(s)");
  const port = Number(process.env.TMA_PORT ?? "3301");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TMA_PORT");
  return { token, secret, owners, port, host:process.env.TMA_HOST || "127.0.0.1" };
}

function headers(res:ServerResponse):void {
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; " +
    "connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; frame-ancestors 'self'");
}
function json(res:ServerResponse,status:number,value:unknown):void {
  res.statusCode=status; res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(value));
}
async function body(req:IncomingMessage,max=128*1024):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of req) {
    const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=part.length;
    if(size>max) throw new Error("Request too large");
    chunks.push(part);
  }
  const data:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("Invalid JSON object");
  return data as Record<string,unknown>;
}
function agentAuthorized(req:IncomingMessage,secret:string):boolean {
  const bearer=req.headers.authorization;
  if(typeof bearer!=="string"||!bearer.startsWith("Bearer "))return false;
  const supplied=Buffer.from(bearer.slice(7),"utf8"),expected=Buffer.from(secret,"utf8");
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
async function serveStatic(pathname:string,res:ServerResponse):Promise<void> {
  const files:Record<string,[string,string]>={
    "/":["index.html","text/html; charset=utf-8"],
    "/app.js":["app.js","text/javascript; charset=utf-8"],
    "/styles.css":["styles.css","text/css; charset=utf-8"],
  };
  const found=files[pathname];
  if(!found){json(res,404,{error:"Not found"});return;}
  try {
    res.setHeader("Content-Type",found[1]);res.end(await readFile(join(home,found[0])));
  } catch {json(res,503,{error:"Static UI unavailable"});}
}
function enqueue(job:TmaJob):Promise<TmaResult> {
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{
      pending.delete(job.id);
      const ix=waiting.findIndex(x=>x.id===job.id);
      if(ix>=0)waiting.splice(ix,1);
      resolve({id:job.id,ok:false,error:"Windows Codex не ответил. Проверьте подключение ПК."});
    },28000);
    pending.set(job.id,{userId:job.userId,resolve,timer});
    if(poller){const waiter=poller;poller=undefined;clearTimeout(waiter.timer);waiter.finish(job);}
    else waiting.push(job);
  });
}
async function route(req:IncomingMessage,res:ServerResponse,cfg:GatewayConfig):Promise<void> {
  headers(res);
  const pathname=new URL(req.url||"/","http://localhost").pathname;
  if(pathname==="/api/health"&&req.method==="GET"){
    json(res,200,{online:Date.now()-lastAgentAt<25000});return;
  }
  if(pathname.startsWith("/api/agent/")){
    if(!agentAuthorized(req,cfg.secret)){json(res,401,{error:"Unauthorized agent"});return;}
    lastAgentAt=Date.now();
    if(pathname==="/api/agent/next"&&req.method==="GET"){
      if(poller){json(res,409,{error:"Agent already polling"});return;}
      let job:TmaJob|undefined;
      while((job=waiting.shift())){if(pending.has(job.id))break;}
      if(job&&pending.has(job.id)){json(res,200,{job});return;}
      await new Promise<void>(resolve=>{
        const timer=setTimeout(()=>{
          if(poller===entry)poller=undefined;
          json(res,200,{job:null});resolve();
        },16000);
        const entry={timer,finish:(received:TmaJob|null)=>{
          json(res,200,{job:received});resolve();
        }};
        poller=entry;
      });
      return;
    }
    if(pathname==="/api/agent/result"&&req.method==="POST"){
      const value=await body(req,9*1024*1024) as unknown as TmaResult;
      if(typeof value.id!=="string"||typeof value.ok!=="boolean"){json(res,400,{error:"Bad result"});return;}
      const state=pending.get(value.id);
      if(!state){json(res,404,{error:"Expired request"});return;}
      clearTimeout(state.timer);pending.delete(value.id);state.resolve(value);
      json(res,200,{ok:true});return;
    }
    json(res,404,{error:"Not found"});return;
  }
  if(pathname==="/api/execute"&&req.method==="POST"){
    const userId=verifyTelegramInitData(
      String(req.headers["x-telegram-init-data"]??""),cfg.token,cfg.owners);
    const payload=await body(req);
    if(!isTmaOperation(payload.op)){json(res,400,{error:"Unknown operation"});return;}
    if(!payload.args||typeof payload.args!=="object"||Array.isArray(payload.args)){
      json(res,400,{error:"Invalid arguments"});return;
    }
    if(pending.size>=32||[...pending.values()].filter(x=>x.userId===userId).length>=4){
      json(res,429,{error:"Слишком много запросов. Подождите завершения предыдущих."});return;
    }
    if(Date.now()-lastAgentAt>25000){json(res,503,{error:"Windows-ПК не подключён"});return;}
    const job:TmaJob={id:randomBytes(12).toString("hex"),op:payload.op,userId,args:payload.args as Record<string,unknown>};
    const result=await enqueue(job);
    json(res,result.ok?200:400,{ok:result.ok,data:result.data,error:result.error});return;
  }
  if(req.method==="GET"&&!pathname.startsWith("/api/")){await serveStatic(pathname,res);return;}
  json(res,404,{error:"Not found"});
}
export function startGateway(cfg=gatewayConfig()){
  const server=createServer((req,res)=>{void route(req,res,cfg).catch(error=>{
    json(res,error?.name==="TmaAuthError"?401:400,{error:(error as Error).message||"Request failed"});
  });});
  server.listen(cfg.port,cfg.host,()=>console.log("Codex TMA gateway listening on "+cfg.host+":"+cfg.port));
  return server;
}
if(process.argv[1]&&process.argv[1].replace(/\\/g,"/").endsWith("/tma/gateway.ts"))startGateway();
