/**
 * Windows-side outbound TMA agent. Reuses the SAME AcpClient/RuntimeRegistry as
 * the Telegram bot and never listens on the PC's public network interface.
 */
import { realpathSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { CodexThreadSummary, CodexProjectSummary } from "../acp/codex-protocol.js";
import { textPrompt } from "../app/types.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import { isVisibleThreadForChat, threadSourceKind } from "../bot/catalog.js";
import { LiveSessionConflictError } from "../bot/session-runtime.js";
import { TmaScreenshotIndex } from "./screenshots.js";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { readConversationHistoryAsync } from "../sessions/history.js";
import { SessionStore } from "../sessions/store.js";
import { TelegramSessionRegistry } from "../sessions/telegram-registry.js";
import { argumentString, isTmaJob, type TmaJob, type TmaResult } from "./protocol.js";
import { parseTmaImages, tmaPromptFingerprint } from "./prompt-images.js";
import { DurablePromptJournal } from "./prompt-journal.js";

const log=createLogger("tma:agent");
const MAX_IMG=3*1024*1024;
function statSyncSafe(path:string):{size:number;mtimeMs:number}{
  try{
    const s=statSync(path);
    return {size:s.size,mtimeMs:s.mtimeMs};
  }catch{return {size:0,mtimeMs:0};}
}
const sleep=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal.aborted)return resolve();
  const t=setTimeout(done,ms);
  function done(){clearTimeout(t);signal.removeEventListener("abort",done);resolve();}
  signal.addEventListener("abort",done,{once:true});
});

export interface AgentDeps { cfg:AppConfig; acp:AcpClient; registry:RuntimeRegistry; }
export class MiniAppAgent {
  private readonly abort=new AbortController();
  private readonly store:SessionStore;
  private readonly telegramSessions:TelegramSessionRegistry;
  private readonly promptJournal:DurablePromptJournal;
  private readonly screenshots=new TmaScreenshotIndex();
  private readonly root:string;
  private readonly secret:string;
  private readonly results=new Map<string,TmaResult>();
  private readonly selected=new Map<number,string>();
  /** Keep send outcomes by client request id so timeout/retry cannot send twice. */
  private readonly sends=new Map<string,{fingerprint:string;promise:Promise<unknown>;at:number}>();
  /** The project/thread catalogue is relatively expensive over app-server.
   * Share a short-lived snapshot between UI status and history requests.
   * Failed refreshes are retried; they are never cached forever. */
  private readonly catalogues = new Map<number, {
    expiresAt: number;
    value: Promise<{projects:CodexProjectSummary[];threads:CodexThreadSummary[]}>;
  }>();
  private readonly ownThreads = new Map<string,CodexThreadSummary>();
  /** Stable last-known authorized session references, eliminating an ACP
   * catalogue round-trip for every frequent history/activity poll. */
  private readonly knownThreads = new Map<number,Map<string,CodexThreadSummary>>();
  private readonly historyCache = new Map<string, {
    size: number; mtimeMs: number; result: unknown;
  }>();
  /** Never launch duplicate deep scans for the same JSONL revision. */
  private readonly historyInflight = new Map<string, Promise<unknown>>();
  private loopPromise:Promise<void>|undefined;
  constructor(private readonly deps:AgentDeps,gatewayUrl:string,secret:string){
    const url=new URL(gatewayUrl);
    if(url.protocol!=="https:"&& !(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname))){
      throw new Error("TMA_GATEWAY_URL must use HTTPS outside localhost");
    }
    this.root=url.href.replace(/\/+$/,"");
    if(secret.length<32)throw new Error("TMA_AGENT_TOKEN must be at least 32 characters");
    this.secret=secret;
    this.store=new SessionStore(deps.cfg.sessionsDir);
    this.telegramSessions=new TelegramSessionRegistry(deps.cfg.dataDir);
    this.promptJournal=new DurablePromptJournal(deps.cfg.dataDir);
  }
  start():void{if(!this.loopPromise)this.loopPromise=this.run();}
  stop():void{this.abort.abort();}
  private async run():Promise<void>{
    log.info("TMA outbound agent connected to "+new URL(this.root).host);
    while(!this.abort.signal.aborted){
      try{
        const rsp=await fetch(this.root+"/api/agent/next",{
          headers:{Authorization:"Bearer "+this.secret},
          signal:this.abort.signal,
        });
        if(rsp.status===401)throw new Error("Invalid TMA_AGENT_TOKEN");
        if(!rsp.ok)throw new Error("Gateway HTTP "+rsp.status);
        const data=await rsp.json() as {job?:unknown};
        if(!data.job)continue;
        const job=data.job;
        if(!isTmaJob(job))continue;
        let result=this.results.get(job.id);
        if(!result){
          try{
            if(!this.deps.cfg.allowedUsers.has(String(job.userId)))throw new Error("Пользователь не разрешён на ПК");
            result={id:job.id,ok:true,data:await this.execute(job)};
          }catch(error){
            const code=error instanceof LiveSessionConflictError?"Сеанс занят Codex Desktop. Можно смотреть историю, но отправлять команды нельзя, пока другой клиент удерживает управление.":(error as Error).message;
            result={id:job.id,ok:false,error:code};
          }
          this.results.set(job.id,result);
          if(this.results.size>128)this.results.delete(this.results.keys().next().value!);
        }
        await fetch(this.root+"/api/agent/result",{
          method:"POST",
          headers:{Authorization:"Bearer "+this.secret,"Content-Type":"application/json"},
          body:JSON.stringify(result),signal:this.abort.signal,
        });
      }catch(error){
        if(this.abort.signal.aborted)break;
        log.warn("TMA gateway not available:",(error as Error).message);
        await sleep(2500,this.abort.signal);
      }
    }
  }
  private async catalogue(userId:number):Promise<{projects:CodexProjectSummary[];threads:CodexThreadSummary[]}>{
    const cached=this.catalogues.get(userId);
    if(cached&&cached.expiresAt>Date.now())return cached.value;
    const value=(async()=>{
      const [projects,threads]=await Promise.all([
        this.deps.acp.listProjects().catch(()=>[] as CodexProjectSummary[]),
        this.deps.acp.listThreads({
          limit:100,sortKey:"recency_at",sortDirection:"desc",
          sourceKinds:["cli","vscode","appServer"],
        }),
      ]);
      const visible=threads.filter(t=>!t.ephemeral&&
        (!this.telegramSessions.get(t.id)||this.telegramSessions.get(t.id)?.chatId===userId)&&
        ["cli","vscode","appServer"].includes(threadSourceKind(t)??""));
      for(const t of this.ownThreads.values()){
        if(this.telegramSessions.get(t.id)?.chatId===userId&&!visible.some(x=>x.id===t.id))visible.unshift(t);
      }
      this.knownThreads.set(userId,new Map(visible.map(t=>[t.id,t])));
      return {projects,threads:visible};
    })();
    this.catalogues.set(userId,{expiresAt:Date.now()+12000,value});
    try{return await value;}
    catch(error){this.catalogues.delete(userId);throw error;}
  }
  private async thread(id:string,userId:number):Promise<CodexThreadSummary>{
    const registered=this.telegramSessions.get(id);
    if(registered && registered.chatId!==userId)throw new Error("Доступ к переписке запрещён");
    const known=this.knownThreads.get(userId)?.get(id);
    if(known)return known;
    const {threads}=await this.catalogue(userId);
    const thread=threads.find(t=>t.id===id);
    if(!thread)throw new Error("Переписка не найдена в последних сеансах Codex");
    return thread;
  }
  /** Validate stream access with the same catalogue/ownership rules as history. */
  async canReadSession(id:string,userId:number):Promise<boolean>{
    if(!/^[a-z0-9-]{8,80}$/i.test(id)||!this.deps.cfg.allowedUsers.has(String(userId)))return false;
    try{await this.thread(id,userId);return true;}catch{return false;}
  }
  private async project(path:string,userId:number):Promise<{name:string;cwd:string}>{
    const {projects,threads}=await this.catalogue(userId);
    // Never trust arbitrary cwd from a web request. It must have been reported
    // by local Codex, or explicitly allowed in the bot's project roots.
    const matched=projects.find(p=>
      p.roots?.some(r=>(typeof r==="string"?r:r.path??r.root)===path));
    const known=threads.some(t=>t.cwd===path);
    const allowed=this.deps.cfg.projectRoots.includes(path)||path===this.deps.cfg.workspace;
    if(!matched&&!known&&!allowed)throw new Error("Папка проекта не разрешена");
    return {name:matched?.name||basename(path),cwd:path};
  }
  async execute(job:TmaJob):Promise<unknown>{
    const {acp,registry,cfg}=this.deps;
    const chatId=job.userId,controller=registry.controller(chatId),args=job.args;
    switch(job.op){
      case "diagnostics":{
        const sent=this.promptJournal.summary();
        return {
          gateway:"online",codexConnected:acp.isConnected,
          uptimeSeconds:Math.floor(process.uptime()),
          pending:sent.reserved,uncertain:sent.uncertain,confirmed:sent.completed,
          botManagedSessions:registry.controller(chatId).list().length,
          checkedAt:Date.now(),
        };
      }
      case "snapshot":{
        const {projects,threads}=await this.catalogue(chatId);
        const controlled=controller.list();
        const active=registry.get(chatId);
        const projectMap=new Map<string,string>();
        for(const p of projects){
          for(const r of p.roots??[]){
            const path=typeof r==="string"?r:r.path??r.root;
            if(path)projectMap.set(path,p.name||basename(path));
          }
        }
        for(const t of threads)if(t.cwd&&!projectMap.has(t.cwd))projectMap.set(t.cwd,basename(t.cwd));
        for(const path of cfg.projectRoots)if(!projectMap.has(path))projectMap.set(path,basename(path));
        if(!projectMap.size)projectMap.set(cfg.workspace,basename(cfg.workspace));
        return {
          projects:[...projectMap].map(([path,name])=>({path,name})),
          sessions:threads.slice(0,100).map(t=>({
            id:t.id,title:(t.name||t.preview||"Новый сеанс").slice(0,180),
            cwd:t.cwd||"",updatedAt:t.recencyAt||t.updatedAt||t.createdAt||0,
            source:threadSourceKind(t)||"unknown",
            busy:controlled.some(c=>c.sessionId===t.id&&c.busy),
            queue:controlled.find(c=>c.sessionId===t.id)?.queueLength||0,
            progress:controlled.find(c=>c.sessionId===t.id)?.progress,
          })),
          selected:this.selected.get(chatId)||active.sessionId||null,
          controlled:controlled.map(c=>({id:c.sessionId,busy:c.busy,queue:c.queueLength,paused:c.queuePaused})),
          model:acp.currentModelId||"default",
          models:acp.availableModels.map(m=>({id:m.modelId,name:m.name})),
          online:true,
        };
      }
      case "activity":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        const path=this.store.jsonlPath(id);
        const file=statSyncSafe(path);
        const rt=registry.runtimeForSession(chatId,id);
        // Scan the evolving rollout while Codex is still working.
        const images=t.cwd?await this.screenshots.scan(id,path,t.cwd):[];
        return {mtimeMs:file.mtimeMs,size:file.size,busy:Boolean(rt?.isBusy),
          queue:rt?.queueLength??0,images,checkedAt:Date.now()};
      }
      case "history":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        const path=this.store.jsonlPath(id);
        // Avoid re-reading multi-megabyte rollout logs every six seconds.
        // A manual refresh still checks the file's current size/mtime first.
        const stat=statSyncSafe(path);
        const cached=this.historyCache.get(id);
        if(cached&&cached.size===stat.size&&cached.mtimeMs===stat.mtimeMs)return cached.result;
        const key=id+":"+stat.size+":"+stat.mtimeMs;
        const existing=this.historyInflight.get(key);
        if(existing)return existing;
        const pending=(async()=>{
          const entries=(await readConversationHistoryAsync(path,40)).map(e=>({
            role:e.role,text:e.text,timestamp:e.timestamp,
          }));
          const refs=t.cwd?await this.screenshots.scan(id,path,t.cwd):[];
          const result={entries,images:refs,project:t.cwd||""};
          // The agent may append to the log during this read. Don't store
          // a stale transcript under a newer file revision.
          const after=statSyncSafe(path);
          if(after.size===stat.size&&after.mtimeMs===stat.mtimeMs){
            this.historyCache.set(id,{...stat,result});
            if(this.historyCache.size>30)this.historyCache.delete(this.historyCache.keys().next().value!);
          }
          return result;
        })();
        this.historyInflight.set(key,pending);
        void pending.then(
          ()=>{this.historyInflight.delete(key);},
          ()=>{this.historyInflight.delete(key);},
        );
        return pending;
      }
      case "create":{
        const target=await this.project(argumentString(args,"cwd",700),chatId);
        const rt=await controller.addNew(target.cwd,target.name);
        if(!rt.sessionId)throw new Error("Новый сеанс не создан");
        this.ownThreads.set(rt.sessionId,{id:rt.sessionId,name:"Новый сеанс",cwd:target.cwd,source:"appServer",createdAt:Date.now()/1000,updatedAt:Date.now()/1000,recencyAt:Date.now()/1000});
        this.knownThreads.get(chatId)?.set(rt.sessionId,this.ownThreads.get(rt.sessionId)!);
        this.catalogues.delete(chatId);
        this.selected.set(chatId,rt.sessionId);
        return {sessionId:rt.sessionId};
      }
      case "select":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        if(!t.cwd)throw new Error("Неизвестная рабочая папка сеанса");
        if(controller.runtimeForSession(id)) await controller.switchTo(id);
        else await controller.addAttach(id,t.cwd,basename(t.cwd),[]);
        this.selected.set(chatId,id);
        return {sessionId:id};
      }
      case "send":{
        const id=argumentString(args,"sessionId",80);
        const message=typeof args.text==="string"&&args.text.length<=16000?args.text.trim():"";
        const images=parseTmaImages(args.images);
        if(!message&&!images.length)throw new Error("Напиши задачу или прикрепи фото");
        const requestId=argumentString(args,"requestId",80);
        const fingerprint=tmaPromptFingerprint(message,images);
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор запроса");
        const key=chatId+":"+id+":"+requestId;
        const existing=this.sends.get(key);
        if(existing){
          if(existing.fingerprint!==fingerprint)throw new Error("Нельзя переиспользовать ID для другого задания");
          return existing.promise;
        }
        const recorded=this.promptJournal.lookup(key,fingerprint);
        if(recorded.found)return recorded.result;
        // Must be flushed to disk before even attempting to attach/send.
        this.promptJournal.reserve(key,fingerprint);
        let dispatched=false;
        const pending=(async()=>{
          try{
            const t=await this.thread(id,chatId);
            if(!t.cwd)throw new Error("Неизвестная рабочая папка");
            if(!controller.runtimeForSession(id))await controller.addAttach(id,t.cwd,basename(t.cwd),[]);
            else if(controller.foreground().sessionId!==id)await controller.switchTo(id);
            this.selected.set(chatId,id);
            const input=textPrompt(message||"Проанализируй прикреплённые изображения.");
            input.images=images;
            // Once this call starts, a crash or ambiguous error may mean Codex
            // already accepted the task; do not automatically resend.
            dispatched=true;
            const result=await registry.submitPrompt(chatId,input);
            const answer={result:result.kind==="submitted"?result.outcome:result.kind};
            this.promptJournal.complete(key,answer);
            return answer;
          }catch(error){
            if(dispatched){
              this.promptJournal.uncertain(key);
            }else{
              this.promptJournal.clearBeforeDispatch(key);
            }
            throw error;
          }
        })();
        this.sends.set(key,{fingerprint,promise:pending,at:Date.now()});
        void pending.catch(()=>{if(!dispatched)this.sends.delete(key);});
        // Cache both successes and failures briefly: never silently repeat an
        // accepted prompt when the browser lost its HTTP response.
        if(this.sends.size>180){
          for(const [k,v] of this.sends)if(Date.now()-v.at>60*60*1000)this.sends.delete(k);
          if(this.sends.size>180)this.sends.delete(this.sends.keys().next().value!);
        }
        return pending;
      }
      case "cancel":{
        const id=argumentString(args,"sessionId",80);
        const rt=registry.runtimeForSession(chatId,id);
        if(!rt)throw new Error("Нельзя остановить чужой или неуправляемый сеанс");
        return {cancelled:await rt.cancel()};
      }
      case "queue":{
        const id=argumentString(args,"sessionId",80);
        const rt=registry.runtimeForSession(chatId,id);
        return {items:rt?.queuedPrompts.map(x=>({id:x.id,text:x.input.displayText||x.input.text}))??[],
          busy:rt?.isBusy??false,paused:rt?.isQueuePaused??false};
      }
      case "queueRemove":{
        const id=argumentString(args,"sessionId",80);
        const rt=registry.runtimeForSession(chatId,id);
        if(!rt)throw new Error("Сеанс не подключён");
        return {removed:rt.removeQueued(argumentString(args,"itemId",64))};
      }
      case "queueResume":{
        const id=argumentString(args,"sessionId",80);
        const rt=registry.runtimeForSession(chatId,id);
        if(!rt)throw new Error("Сеанс не подключён");
        return {resumed:rt.resumeQueue()};
      }
      case "image":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        if(!t.cwd)throw new Error("Неизвестная папка проекта");
        const candidate=argumentString(args,"path",1200);
        const referenced=await this.screenshots.authorized(id,this.store.jsonlPath(id),t.cwd,candidate);
        if(!referenced)throw new Error("Изображение не относится к этому сеансу");
        const root=realpathSync(t.cwd),real=realpathSync(candidate);
        const rel=relative(root,real);
        if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel))throw new Error("Недопустимый путь");
        const ext=extname(real).toLowerCase();
        const mime=({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif"} as Record<string,string>)[ext];
        if(!mime)throw new Error("Неподдерживаемый формат");
        const stat=statSync(real);
        if(!stat.isFile()||stat.size>MAX_IMG)throw new Error("Изображение слишком большое");
        return {name:basename(real),mime,data:readFileSync(real).toString("base64")};
      }
    }
  }
}

export function startMiniAppAgent(deps:AgentDeps):MiniAppAgent|undefined{
  const url=(process.env.TMA_GATEWAY_URL||"").trim(),secret=(process.env.TMA_AGENT_TOKEN||"").trim();
  if(!url&&!secret)return undefined;
  if(!url||!secret){log.warn("TMA disabled: specify both TMA_GATEWAY_URL and TMA_AGENT_TOKEN");return undefined;}
  const agent=new MiniAppAgent(deps,url,secret);agent.start();return agent;
}
