/**
 * Windows-side outbound TMA agent. Reuses the SAME AcpClient/RuntimeRegistry as
 * the Telegram bot and never listens on the PC's public network interface.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AcpClient } from "../acp/client.js";
import type { CodexThreadSummary, CodexProjectSummary, CodexRateLimitWindow, CodexThreadGoalStatus } from "../acp/codex-protocol.js";
import { REASONING_LEVELS, textPrompt, type ReasoningEffort } from "../app/types.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import { isVisibleThreadForChat, threadSourceKind } from "../bot/catalog.js";
import { LiveSessionConflictError } from "../bot/session-runtime.js";
import { TmaScreenshotIndex } from "./screenshots.js";
import type { AppConfig } from "../config.js";
import { isPathWithinRoot } from "../projects/manager.js";
import { buildContentBlocks } from "../bot/prompt-content.js";
import { createLogger } from "../logger.js";
import { readConversationHistoryAsync } from "../sessions/history.js";
import { SessionStore } from "../sessions/store.js";
import { TelegramSessionRegistry } from "../sessions/telegram-registry.js";
import { argumentString, isTmaJob, type TmaJob, type TmaResult } from "./protocol.js";
import { parseTmaImages, tmaPromptFingerprint } from "./prompt-images.js";
import { DurablePromptJournal } from "./prompt-journal.js";
import { normalizeMobileIntegrations, normalizePluginInstallResult } from "../mobile/integrations.js";

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
export type MobileLocalOperation = "capabilities" | "setModel" | "setMode" | "setReasoning" | "setGoal" | "clearGoal" | "steer" | "forkThread" | "compactThread" | "archiveThread" | "unarchiveThread" | "renameThread" | "installPlugin" | "uninstallPlugin" | "files" | "readFile" | "writeFile" | "createFile" | "gitStatus" | "gitDiff" | "gitStage" | "gitUnstage" | "gitCommit" | "gitCreateBranch" | "gitSwitchBranch";
export interface MobileLocalJob { op:MobileLocalOperation; userId:number; args:Record<string,unknown>; }
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
  private readonly archivedCatalogues = new Map<number, {
    expiresAt: number;
    value: Promise<CodexThreadSummary[]>;
  }>();
  private readonly archivedThreads = new Map<number,Map<string,CodexThreadSummary>>();
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
  constructor(private readonly deps:AgentDeps,gatewayUrl?:string,secret?:string){
    if(Boolean(gatewayUrl)!==Boolean(secret))throw new Error("TMA gateway URL and token must be configured together");
    if(gatewayUrl&&secret){
      const url=new URL(gatewayUrl);
      if(url.protocol!=="https:"&& !(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname))){
        throw new Error("TMA_GATEWAY_URL must use HTTPS outside localhost");
      }
      if(secret.length<32)throw new Error("TMA_AGENT_TOKEN must be at least 32 characters");
      this.root=url.href.replace(/\/+$/,"");
      this.secret=secret;
    }else{
      // Mobile-only callers reuse this business adapter in-process and never
      // start the outbound long-poll transport.
      this.root="";
      this.secret="";
    }
    this.store=new SessionStore(deps.cfg.sessionsDir);
    this.telegramSessions=new TelegramSessionRegistry(deps.cfg.dataDir);
    this.promptJournal=new DurablePromptJournal(deps.cfg.dataDir);
  }
  start():void{
    if(!this.root||!this.secret)throw new Error("Starting the outbound Mini App agent requires a TMA gateway");
    if(!this.loopPromise){
      this.loopPromise=this.run();
      void this.runHeartbeat();
    }
  }
  stop():void{this.abort.abort();}
  private async runHeartbeat():Promise<void>{
    while(!this.abort.signal.aborted){
      try{
        const rsp=await fetch(this.root+"/api/agent/heartbeat",{
          method:"POST",
          headers:{Authorization:"Bearer "+this.secret},
          signal:this.abort.signal,
        });
        if(!rsp.ok)throw new Error("Gateway HTTP "+rsp.status);
      }catch(error){
        if(this.abort.signal.aborted)break;
        log.warn("TMA heartbeat failed:",(error as Error).message);
      }
      await sleep(10_000,this.abort.signal);
    }
  }
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
        (typeof this.deps.acp.listAllThreads==="function"?this.deps.acp.listAllThreads({
          limit:100,sortKey:"recency_at",sortDirection:"desc",
          sourceKinds:["cli","vscode","appServer"],
        }):this.deps.acp.listThreads({
          limit:100,sortKey:"recency_at",sortDirection:"desc",
          sourceKinds:["cli","vscode","appServer"],
        })),
      ]);
      const visible=threads.filter(t=>!t.ephemeral&&
        (!this.telegramSessions.getOwner(t.id)||this.telegramSessions.getOwner(t.id)?.chatId===userId)&&
        ["cli","vscode","appServer"].includes(threadSourceKind(t)??""));
      for(const t of this.ownThreads.values()){
        if(this.telegramSessions.getOwner(t.id)?.chatId===userId&&!visible.some(x=>x.id===t.id))visible.unshift(t);
      }
      const known=this.knownThreads.get(userId)??new Map<string,CodexThreadSummary>();
      // A transient app-server catalogue may omit an open session. Keep
      // previously authorized references so TMA can still read and send to it.
      // Refresh visible entries in recency order for bounded LRU eviction.
      for(const t of [...visible].reverse()){
        known.delete(t.id);
        known.set(t.id,t);
        this.archivedThreads.get(userId)?.delete(t.id);
      }
      const selected=this.selected.get(userId);
      while(known.size>500){
        const oldest=known.keys().next().value;
        if(oldest===undefined)break;
        if(oldest===selected){
          const thread=known.get(oldest);
          known.delete(oldest);
          if(thread)known.set(oldest,thread);
        }else known.delete(oldest);
      }
      this.knownThreads.set(userId,known);
      return {projects,threads:visible};
    })();
    this.catalogues.set(userId,{expiresAt:Date.now()+12000,value});
    try{return await value;}
    catch(error){this.catalogues.delete(userId);throw error;}
  }
  private async archivedCatalogue(userId:number):Promise<CodexThreadSummary[]>{
    const cached=this.archivedCatalogues.get(userId);
    if(cached&&cached.expiresAt>Date.now())return cached.value;
    const value=(async()=>{
      const params={limit:100,sortKey:"recency_at" as const,sortDirection:"desc" as const,
        sourceKinds:["cli","vscode","appServer"] as Array<"cli"|"vscode"|"appServer">,archived:true};
      const threads=typeof this.deps.acp.listAllThreads==="function"
        ? await this.deps.acp.listAllThreads(params)
        : await this.deps.acp.listThreads(params);
      const visible=threads.filter(t=>!t.ephemeral&&
        (!this.telegramSessions.getOwner(t.id)||this.telegramSessions.getOwner(t.id)?.chatId===userId)&&
        ["cli","vscode","appServer"].includes(threadSourceKind(t)??""));
      const known=this.archivedThreads.get(userId)??new Map<string,CodexThreadSummary>();
      for(const t of [...visible].reverse()){
        known.delete(t.id);
        known.set(t.id,t);
        const active=this.knownThreads.get(userId);
        active?.delete(t.id);
      }
      while(known.size>500){
        const oldest=known.keys().next().value;
        if(oldest===undefined)break;
        known.delete(oldest);
      }
      this.archivedThreads.set(userId,known);
      return visible;
    })();
    this.archivedCatalogues.set(userId,{expiresAt:Date.now()+12000,value});
    try{return await value;}
    catch(error){this.archivedCatalogues.delete(userId);throw error;}
  }
  private async thread(id:string,userId:number):Promise<CodexThreadSummary>{
    const registered=this.telegramSessions.getOwner(id);
    if(registered && registered.chatId!==userId)throw new Error("Доступ к переписке запрещён");
    const known=this.knownThreads.get(userId)?.get(id);
    if(known)return known;
    const {threads}=await this.catalogue(userId);
    const thread=threads.find(t=>t.id===id);
    if(thread)return thread;
    const archivedKnown=this.archivedThreads.get(userId)?.get(id);
    if(archivedKnown)return archivedKnown;
    const archived=(await this.archivedCatalogue(userId)).find(t=>t.id===id);
    if(archived){
      const activeKnown=this.knownThreads.get(userId)??new Map<string,CodexThreadSummary>();
      activeKnown.set(id,archived);
      this.knownThreads.set(userId,activeKnown);
      return archived;
    }
    throw new Error("Переписка не найдена в последних сеансах Codex");
  }
  private async isArchivedThread(id:string,userId:number):Promise<boolean>{
    if(this.knownThreads.get(userId)?.has(id))return this.archivedThreads.get(userId)?.has(id)??false;
    if(this.archivedThreads.get(userId)?.has(id))return true;
    return (await this.archivedCatalogue(userId)).some(thread=>thread.id===id);
  }
  /** Validate stream access with the same catalogue/ownership rules as history. */
  async canReadSession(id:string,userId:number):Promise<boolean>{
    if(!/^[a-z0-9_-]{8,128}$/i.test(id)||!this.deps.cfg.allowedUsers.has(String(userId)))return false;
    try{await this.thread(id,userId);return true;}catch{return false;}
  }
  /** Mobile-only inventories and preference changes. These are deliberately
   * kept out of TMA_OPERATIONS so the remote Telegram gateway cannot dispatch them. */
  async executeMobile(job:MobileLocalJob):Promise<unknown>{
    const {acp,registry,cfg}=this.deps;
    const chatId=job.userId,args=job.args;
    if(!cfg.allowedUsers.has(String(chatId)))throw new Error("Пользователь не разрешён на ПК");
    const sessionId=typeof args.sessionId==="string"?args.sessionId:"";
    if(job.op!=="capabilities"&&!sessionId)throw new Error("Сначала выберите сеанс Codex");
    const runtime=sessionId?registry.runtimeForSession(chatId,sessionId):undefined;
    switch(job.op){
      case "renameThread":{
        const thread=await this.thread(sessionId,chatId);
        const name=argumentString(args,"name",120).trim();
        if(!name||/[\u0000-\u001f\u007f]/.test(name))throw new Error("Укажите название сеанса длиной до 120 символов");
        await acp.setThreadName(sessionId,name);
        const renamed={...thread,name};
        this.knownThreads.get(chatId)?.set(sessionId,renamed);
        if(this.archivedThreads.get(chatId)?.has(sessionId))this.archivedThreads.get(chatId)?.set(sessionId,renamed);
        if(this.ownThreads.has(sessionId))this.ownThreads.set(sessionId,renamed);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,name};
      }
      case "forkThread":{
        const source=await this.thread(sessionId,chatId);
        if(!source.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(runtime?.isBusy||acp.hasActiveTurn(sessionId))throw new Error("Нельзя ответвить сеанс, пока Codex выполняет задачу");
        const fork=await acp.forkThread(sessionId);
        const forkId=fork.thread.id;
        if(!/^[a-z0-9_-]{8,128}$/i.test(forkId))throw new Error("Codex вернул недопустимый ID нового сеанса");
        const sourceRoot=realpathSync.native(source.cwd);
        const forkRoot=realpathSync.native(fork.cwd||source.cwd);
        if(resolve(sourceRoot).toLowerCase()!==resolve(forkRoot).toLowerCase())throw new Error("Codex ответвил сеанс в другой папке проекта");
        const now=Date.now()/1000;
        const child:CodexThreadSummary={
          ...fork.thread,
          id:forkId,
          name:typeof fork.thread.name==="string"&&fork.thread.name.trim()?fork.thread.name:`${source.name||"Сеанс"} · ответвление`,
          cwd:source.cwd,
          source:fork.thread.source||"appServer",
          createdAt:typeof fork.thread.createdAt==="number"?fork.thread.createdAt:now,
          updatedAt:typeof fork.thread.updatedAt==="number"?fork.thread.updatedAt:now,
          recencyAt:typeof fork.thread.recencyAt==="number"?fork.thread.recencyAt:now,
          parentThreadId:sessionId,
        };
        this.telegramSessions.recordMobile(forkId,chatId,source.cwd,basename(source.cwd));
        this.ownThreads.set(forkId,child);
        const known=this.knownThreads.get(chatId)??new Map<string,CodexThreadSummary>();
        known.set(forkId,child);
        this.knownThreads.set(chatId,known);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        this.selected.set(chatId,forkId);
        return {sessionId:forkId};
      }
      case "compactThread":{
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Восстановите сеанс из архива перед сокращением контекста");
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(runtime?.isBusy||acp.hasActiveTurn(sessionId))throw new Error("Нельзя сократить контекст, пока Codex выполняет задачу");
        await acp.compactThread(sessionId);
        return {started:true};
      }
      case "archiveThread":{
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сеанс уже находится в архиве");
        if(runtime?.isBusy)throw new Error("Нельзя архивировать сеанс, пока Codex выполняет задачу");
        await acp.archiveThread(sessionId);
        this.knownThreads.get(chatId)?.delete(sessionId);
        this.archivedThreads.get(chatId)?.set(sessionId,thread);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,archived:true};
      }
      case "unarchiveThread":{
        const thread=await this.thread(sessionId,chatId);
        if(!await this.isArchivedThread(sessionId,chatId))throw new Error("Сеанс не найден в архиве");
        await acp.unarchiveThread(sessionId);
        this.archivedThreads.get(chatId)?.delete(sessionId);
        const known=this.knownThreads.get(chatId)??new Map<string,CodexThreadSummary>();
        known.set(sessionId,thread);
        this.knownThreads.set(chatId,known);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,archived:false};
      }
      case "setGoal":{
        const thread=await this.thread(sessionId,chatId);
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        const input:{objective?:string;status?:CodexThreadGoalStatus;tokenBudget?:number|null}={};
        if(args.objective!==undefined){
          if(typeof args.objective!=="string")throw new Error("Цель должна быть текстом");
          input.objective=args.objective;
        }
        if(args.status!==undefined){
          const statuses:CodexThreadGoalStatus[]=["active","paused","blocked","usageLimited","budgetLimited","complete"];
          if(typeof args.status!=="string"||!statuses.includes(args.status as CodexThreadGoalStatus))throw new Error("Неизвестный статус цели");
          input.status=args.status as CodexThreadGoalStatus;
        }
        if(args.tokenBudget===null)input.tokenBudget=null;
        else if(args.tokenBudget!==undefined){
          if(typeof args.tokenBudget!=="number"||!Number.isSafeInteger(args.tokenBudget)||args.tokenBudget<1||args.tokenBudget>1_000_000_000)
            throw new Error("Бюджет должен быть целым числом от 1 до 1 000 000 000 токенов");
          input.tokenBudget=args.tokenBudget;
        }
        const goal=await acp.setThreadGoal(sessionId,input);
        return {goal};
      }
      case "clearGoal":{
        await this.thread(sessionId,chatId);
        return await acp.clearThreadGoal(sessionId);
      }
      case "steer":{
        const text=typeof args.text==="string"&&args.text.length<=16000?args.text.trim():"";
        const images=parseTmaImages(args.images);
        if(!text&&!images.length)throw new Error("Напишите направление для Codex или прикрепите фото");
        const requestId=argumentString(args,"requestId",80);
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор направления");
        const fingerprint=tmaPromptFingerprint("steer:"+text,images);
        const key=chatId+":"+sessionId+":steer:"+requestId;
        const existing=this.sends.get(key);
        if(existing){
          if(existing.fingerprint!==fingerprint)throw new Error("Нельзя переиспользовать ID для другого направления");
          return existing.promise;
        }
        const recorded=this.promptJournal.lookup(key,fingerprint);
        if(recorded.found)return recorded.result;
        this.promptJournal.reserve(key,fingerprint);
        let dispatched=false;
        const pending=(async()=>{
          try{
            const thread=await this.thread(sessionId,chatId);
            if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
            if(!runtime?.isBusy||!acp.canSteer(sessionId))throw new Error("Текущую задачу нельзя направить: у этого клиента нет подтверждённого активного хода Codex");
            if(!thread.cwd)throw new Error("Неизвестная рабочая папка сеанса");
            const input=textPrompt(text||"Проанализируй прикреплённые изображения.");
            input.images=images;
            dispatched=true;
            await acp.steer(sessionId,buildContentBlocks(input));
            const result={steered:true};
            this.promptJournal.complete(key,result);
            return result;
          }catch(error){
            if(dispatched)this.promptJournal.uncertain(key);
            else this.promptJournal.clearBeforeDispatch(key);
            throw error;
          }
        })();
        this.sends.set(key,{fingerprint,promise:pending,at:Date.now()});
        void pending.catch(()=>{if(!dispatched)this.sends.delete(key);});
        if(this.sends.size>180){
          for(const [k,v] of this.sends)if(Date.now()-v.at>60*60*1000)this.sends.delete(k);
          if(this.sends.size>180)this.sends.delete(this.sends.keys().next().value!);
        }
        return pending;
      }
      case "capabilities":{
        if(sessionId&&!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(acp.isConnected)await acp.refreshInventories();
        const integrationThread=sessionId?await this.thread(sessionId,chatId).catch(()=>undefined):undefined;
        const rawIntegrations=acp.isConnected&&typeof acp.mobileIntegrationInventory==="function"
          ? await acp.mobileIntegrationInventory(integrationThread?.cwd,sessionId||undefined).catch(()=>undefined)
          : undefined;
        const integrations=normalizeMobileIntegrations(rawIntegrations?.pluginCatalog,rawIntegrations?.installedPlugins,
          rawIntegrations?.apps,rawIntegrations?.installedApps);
        let goal:Awaited<ReturnType<AcpClient["getThreadGoal"]>>;
        let goalAvailable=false;
        if(sessionId&&acp.isConnected){
          try{goal=await acp.getThreadGoal(sessionId);goalAvailable=true;}
          catch{goal=undefined;}
        }
        const account:Awaited<ReturnType<AcpClient["accountState"]>>=acp.isConnected?await acp.accountState().catch(()=>({})):{};
        const normalizeWindow=(value:CodexRateLimitWindow|null|undefined)=>value&&Number.isFinite(value.usedPercent)?{
          usedPercent:Math.max(0,Math.min(100,value.usedPercent)),
          windowDurationMins:typeof value.windowDurationMins==="number"&&Number.isFinite(value.windowDurationMins)?value.windowDurationMins:undefined,
          resetsAt:typeof value.resetsAt==="number"&&Number.isFinite(value.resetsAt)?value.resetsAt:undefined,
        }:undefined;
        const limits=account.rateLimitsByLimitId?Object.entries(account.rateLimitsByLimitId).map(([id,limit])=>({
          id:id.slice(0,80),name:typeof limit.limitName==="string"?limit.limitName.slice(0,100):id.slice(0,80),
          primary:normalizeWindow(limit.primary),secondary:normalizeWindow(limit.secondary),
        })).slice(0,20):account.rateLimits?[{id:"default",name:"Лимиты Codex",primary:normalizeWindow(account.rateLimits.primary),secondary:normalizeWindow(account.rateLimits.secondary)}]:[];
        const subagents=acp.currentSubagents().filter(s=>registry.ownerChatForSession(s.sessionId)===chatId).slice(0,30).map(s=>({
          id:s.sessionId,name:(s.sessionName||s.agentName||"Агент").slice(0,120),status:(s.status?.type||"unknown").slice(0,60),
        }));
        return {
          online:acp.isConnected,
          model:runtime?.model||acp.currentModelId||"default",
          mode:runtime?.agent||acp.currentModeId||"",
          reasoning:runtime?.reasoning||"medium",
          models:acp.availableModels.slice(0,100).map(m=>({id:m.modelId.slice(0,160),name:m.name.slice(0,160),description:m.description?.slice(0,400)})),
          modes:acp.availableModes.slice(0,60).map(m=>({id:m.id.slice(0,100),name:m.name.slice(0,120),description:m.description?.slice(0,300)})),
          reasoningLevels:REASONING_LEVELS,
          skills:acp.availableSkills.filter(s=>s.enabled!==false).slice(0,100).map(s=>({name:s.name.slice(0,160),description:s.description?.slice(0,500)})),
          mcpServers:acp.availableMcpServers.slice(0,60).map(s=>({name:s.name.slice(0,120),toolCount:Object.keys(s.tools??{}).length})),
          plugins:integrations.plugins,pluginCatalogAvailable:integrations.pluginCatalogAvailable,
          apps:integrations.apps,appsAvailable:integrations.appsAvailable,
          account:account.account?{type:account.account.type,email:account.account.email?.slice(0,200),plan:account.account.planType?.slice(0,100)}:undefined,
          limits,subagents,checkedAt:Date.now(),
          goal,goalAvailable,
        };
      }
      case "installPlugin":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const thread=await this.thread(sessionId,chatId);
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const pluginId=argumentString(args,"pluginId",200);
        const marketplaceName=argumentString(args,"marketplace",120);
        if(!pluginId||!marketplaceName)throw new Error("Плагин не выбран из каталога Codex");
        const result=await acp.installMobilePlugin(pluginId,marketplaceName,thread.cwd);
        return {installed:true,authorizationRequired:normalizePluginInstallResult(result)};
      }
      case "uninstallPlugin":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const pluginId=argumentString(args,"pluginId",200);
        if(!pluginId)throw new Error("Плагин не выбран из списка Codex");
        await acp.uninstallMobilePlugin(pluginId);
        return {uninstalled:true};
      }
      case "setModel":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        const model=argumentString(args,"modelId",160);
        if(model!=="default"&&!acp.hasModel(model))throw new Error("Эта модель сейчас недоступна");
        const result=await runtime.setModelPref(model==="default"?"":model);
        if(!result.ok)throw new Error(result.error||"Не удалось сменить модель");
        return {model:model==="default"?"default":model};
      }
      case "setMode":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        const mode=argumentString(args,"modeId",100);
        if(mode!=="default"&&!acp.hasMode(mode))throw new Error("Этот режим сейчас недоступен");
        const result=await runtime.setAgentPref(mode==="default"?"":mode);
        if(!result.ok)throw new Error(result.error||"Не удалось сменить режим");
        return {mode:mode==="default"?"":mode};
      }
      case "setReasoning":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        const effort=argumentString(args,"effort",20);
        if(!REASONING_LEVELS.includes(effort as ReasoningEffort))throw new Error("Недопустимый уровень рассуждений");
        runtime.setReasoningPref(effort as ReasoningEffort);
        return {reasoning:effort};
      }
      case "files":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileFileList(sessionId,chatId,typeof args.path==="string"?args.path:"");
      }
      case "readFile":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileReadFile(sessionId,chatId,argumentString(args,"path",1200));
      }
      case "writeFile":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const content=typeof args.content==="string"?args.content:undefined;
        const expectedHash=argumentString(args,"expectedHash",64);
        if(content===undefined||Buffer.byteLength(content,"utf8")>512*1024)throw new Error("Файл больше 512 КБ или имеет неверный формат");
        const target=this.mobileReadFile(sessionId,chatId,argumentString(args,"path",1200));
        if(!/^[a-f0-9]{64}$/.test(expectedHash)||target.sha256!==expectedHash)throw new Error("Файл изменился после открытия. Перезагрузите его перед сохранением.");
        const runtime=registry.runtimeForSession(chatId,sessionId);
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        if(runtime.isBusy)throw new Error("Дождитесь завершения текущей задачи Codex перед сохранением файла");
        const root=this.mobileRoot(sessionId,chatId).root;
        const absolute=this.mobilePath(root,argumentString(args,"path",1200));
        const temp=absolute+".codex-mobile-"+randomBytes(8).toString("hex")+".tmp";
        const mode=statSync(absolute).mode&0o777;
        try{
          writeFileSync(temp,content,{encoding:"utf8",flag:"wx",mode});
          const parent=realpathSync.native(dirname(absolute));
          if(!isPathWithinRoot(root,parent)||lstatSync(absolute).isSymbolicLink())throw new Error("Путь проекта изменился во время сохранения");
          const latest=this.mobileReadFile(sessionId,chatId,argumentString(args,"path",1200));
          if(latest.sha256!==expectedHash)throw new Error("Файл изменился во время сохранения. Перезагрузите его перед сохранением.");
          renameSync(temp,absolute);
        }finally{try{unlinkSync(temp);}catch{/* rename already removed the temporary file */}}
        return {path:target.path,sha256:createHash("sha256").update(content,"utf8").digest("hex"),savedAt:Date.now()};
      }
      case "createFile":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const content=typeof args.content==="string"?args.content:undefined;
        const rawPath=argumentString(args,"path",1200);
        if(content===undefined||Buffer.byteLength(content,"utf8")>512*1024)throw new Error("Файл больше 512 КБ или имеет неверный формат");
        if(!rawPath||isAbsolute(rawPath)||/^[a-z]:/i.test(rawPath)||rawPath.startsWith("\\\\"))throw new Error("Ожидался относительный путь внутри проекта");
        const parts=rawPath.split(/[\\/]+/).filter(Boolean);
        if(parts.some(part=>part===".."||part==="."||part.includes(":")||part.includes("\0")))throw new Error("Недопустимый путь внутри проекта");
        if(parts.some(part=>this.isHiddenMobileFile(part)))throw new Error("Этот файл недоступен в мобильном просмотре");
        const name=parts.pop();
        if(!name||this.isHiddenMobileFile(name))throw new Error("Этот файл недоступен в мобильном просмотре");
        const {root}=this.mobileRoot(sessionId,chatId);
        const parent=parts.length?this.mobilePath(root,parts.join("/")):root;
        if(!statSync(parent).isDirectory())throw new Error("Папка для нового файла не найдена");
        const actualParent=realpathSync.native(parent);
        if(!isPathWithinRoot(root,actualParent))throw new Error("Путь выходит за пределы проекта");
        const absolute=resolve(actualParent,name);
        if(!isPathWithinRoot(root,absolute))throw new Error("Путь выходит за пределы проекта");
        try{lstatSync(absolute);throw new Error("Файл уже существует");}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        const runtime=registry.runtimeForSession(chatId,sessionId);
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        if(runtime.isBusy)throw new Error("Дождитесь завершения текущей задачи Codex перед созданием файла");
        try{writeFileSync(absolute,content,{encoding:"utf8",flag:"wx"});}
        catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("Файл уже существует");throw error;}
        return {path:relative(root,absolute).split(sep).join("/"),sha256:createHash("sha256").update(content,"utf8").digest("hex"),savedAt:Date.now()};
      }
      case "gitStatus":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileGitStatus(sessionId,chatId);
      }
      case "gitDiff":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileGitDiff(sessionId,chatId,args);
      }
      case "gitStage":
      case "gitUnstage":
      case "gitCommit":
      case "gitCreateBranch":
      case "gitSwitchBranch":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root,name}=this.mobileRoot(sessionId,chatId);
        const gitRoot=this.gitRoot(root);
        if(job.op==="gitStage"||job.op==="gitUnstage"){
          const paths=[this.mobileGitPath(root,argumentString(args,"path",1200))];
          if(job.op==="gitUnstage"&&typeof args.previousPath==="string")paths.push(this.mobileGitPath(root,args.previousPath));
          const gitArgs=job.op==="gitStage"?["add","--all","--",...paths]:this.gitHasHead(gitRoot)?["reset","-q","HEAD","--",...paths]:["rm","--cached","--quiet","--ignore-unmatch","--",...paths];
          this.gitMutation(gitRoot,gitArgs);
          return {paths,staged:job.op==="gitStage"};
        }
        if(job.op==="gitCommit"){
          const message=argumentString(args,"message",200).trim();
          if(!message||/[\u0000-\u001f\u007f]/.test(message))throw new Error("Укажите короткое однострочное сообщение коммита");
          this.gitMutation(gitRoot,["commit","-m",message]);
          const commit=this.gitOutput(gitRoot,["rev-parse","--short","HEAD"],1024).trim();
          return {project:name,commit,message,branch:this.mobileGitStatus(sessionId,chatId).branch};
        }
        const branch=argumentString(args,"name",120).trim();
        if(!branch||/[\u0000-\u001f\u007f]/.test(branch))throw new Error("Укажите допустимое имя ветки");
        this.gitMutation(gitRoot,["check-ref-format","--branch",branch]);
        if(job.op==="gitCreateBranch")this.gitMutation(gitRoot,["switch","--create",branch]);
        else{
          if(!this.mobileGitStatus(sessionId,chatId).branches.includes(branch))throw new Error("Не удалось найти ветку в этом проекте");
          this.gitMutation(gitRoot,["switch","--quiet","--",branch]);
        }
        return {project:name,branch};
      }
    }
  }
  private requireIdleMobileRuntime(sessionId:string,userId:number):void{
    const runtime=this.deps.registry.runtimeForSession(userId,sessionId);
    if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
    if(runtime.isBusy)throw new Error("Дождитесь завершения текущей задачи Codex перед изменением настроек или файлов проекта");
  }
  private mobileRoot(sessionId:string,userId:number):{root:string;name:string}{
    const thread=this.knownThreads.get(userId)?.get(sessionId);
    const cwd=thread?.cwd;
    if(!cwd)throw new Error("Для сеанса не определена папка проекта");
    const known=this.knownThreads.get(userId);
    if(!known?.has(sessionId))throw new Error("Доступ к проекту запрещён");
    const root=realpathSync.native(cwd);
    if(!statSync(root).isDirectory())throw new Error("Папка проекта недоступна");
    return {root,name:thread.name||basename(root)};
  }
  private mobilePath(root:string,rawPath:string):string{
    if(rawPath.length>1200||isAbsolute(rawPath)||/^[a-z]:/i.test(rawPath)||rawPath.startsWith("\\\\"))throw new Error("Ожидался относительный путь внутри проекта");
    const parts=rawPath.split(/[\\/]+/).filter(Boolean);
    if(parts.some(part=>part===".."||part==="."||part.includes(":")||part.includes("\0")))throw new Error("Недопустимый путь внутри проекта");
    const candidate=resolve(root,...parts);
    if(!isPathWithinRoot(root,candidate))throw new Error("Путь выходит за пределы проекта");
    const stat=lstatSync(candidate);
    if(stat.isSymbolicLink())throw new Error("Символические ссылки через мобильный файловый просмотр не открываются");
    const actual=realpathSync.native(candidate);
    if(!isPathWithinRoot(root,actual))throw new Error("Путь выходит за пределы проекта");
    return actual;
  }
  private isHiddenMobileFile(name:string):boolean{
    const lower=name.toLowerCase();
    return new Set([".git","node_modules",".codex",".ssh",".history",".cache","dist","build","out","target",".venv","__pycache__"]).has(lower)||
      /^\.env(?:\.|$)/i.test(name)||/^\.npmrc$/i.test(name)||/^(?:id_rsa|id_ed25519|credentials?)(?:\.|$)/i.test(name)||/\.(?:pem|key|p12|pfx)$/i.test(name);
  }
  private mobileFileList(sessionId:string,userId:number,rawPath:string){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const directory=rawPath?this.mobilePath(root,rawPath):root;
    if(!statSync(directory).isDirectory())throw new Error("Это не папка проекта");
    const entries=readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
      if(this.isHiddenMobileFile(entry.name))return [];
      const absolute=resolve(directory,entry.name);
      try{
        const info=lstatSync(absolute);
        if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))return [];
        return [{name:entry.name,kind:info.isDirectory()?"directory" as const:"file" as const,
          size:info.isFile()?info.size:undefined,mtimeMs:info.mtimeMs}];
      }catch{return [];}
    }).sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==="directory"?-1:1).slice(0,250);
    return {project:name,path:rawPath.split(/[\\/]+/).filter(Boolean).join("/"),entries};
  }
  private mobileReadFile(sessionId:string,userId:number,rawPath:string){
    const {root,name}=this.mobileRoot(sessionId,userId);
    if(!rawPath||rawPath.split(/[\\/]+/).some(part=>this.isHiddenMobileFile(part)))throw new Error("Этот файл недоступен в мобильном просмотре");
    const absolute=this.mobilePath(root,rawPath);
    const stat=statSync(absolute);
    if(!stat.isFile()||stat.size>512*1024)throw new Error("Открываются только текстовые файлы размером до 512 КБ");
    const bytes=readFileSync(absolute);
    if(bytes.includes(0))throw new Error("Бинарный файл нельзя открыть как текст");
    let text:string;
    try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("Файл не является корректным UTF-8 текстом");}
    return {project:name,path:relative(root,absolute).split(sep).join("/"),text,size:stat.size,
      sha256:createHash("sha256").update(bytes).digest("hex")};
  }
  private gitRoot(projectRoot:string):string{
    try{
      const output=execFileSync("git",["--no-pager","-C",projectRoot,"-c","core.fsmonitor=false","rev-parse","--show-toplevel"],{
        encoding:"utf8",timeout:5000,maxBuffer:64*1024,windowsHide:true,stdio:["ignore","pipe","ignore"],
      }).trim();
      if(!output)throw new Error("empty git root");
      const root=realpathSync.native(output);
      if(!isPathWithinRoot(projectRoot,root))throw new Error("Git root leaves the authorized project");
      return root;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error("Git не установлен или не найден");
      if((error as Error).message==="Git root leaves the authorized project")throw error;
      throw new Error("В доступной папке не найден Git-репозиторий");
    }
  }
  private gitOutput(root:string,args:string[],maxBuffer=2*1024*1024):string{
    try{
      return execFileSync("git",["--no-pager","-C",root,"-c","core.fsmonitor=false","-c","core.quotePath=false",...args],{
        encoding:"utf8",timeout:8000,maxBuffer,windowsHide:true,stdio:["ignore","pipe","ignore"],
      });
    }catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOBUFS")throw new Error("Вывод Git больше 2 МБ; сузьте изменения и повторите просмотр");
      if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error("Git не установлен или не найден");
      throw new Error("Не удалось прочитать состояние Git");
    }
  }
  private gitMutation(root:string,args:string[]):string{
    try{
      return execFileSync("git",["--no-pager","-C",root,"-c","core.fsmonitor=false","-c","color.ui=false","--literal-pathspecs",...args],{
        encoding:"utf8",timeout:15_000,maxBuffer:512*1024,windowsHide:true,stdio:["ignore","pipe","pipe"],
      });
    }catch(error){
      const failure=error as NodeJS.ErrnoException & {stderr?:Buffer|string};
      if(failure.code==="ENOENT")throw new Error("Git не установлен или не найден");
      if(failure.code==="ETIMEDOUT")throw new Error("Команда Git превысила лимит времени");
      const detail=Buffer.isBuffer(failure.stderr)?failure.stderr.toString("utf8"):typeof failure.stderr==="string"?failure.stderr:"";
      const safe=detail.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,"").trim().slice(0,500);
      throw new Error(safe||"Git не выполнил действие");
    }
  }
  private gitHasHead(root:string):boolean{
    try{
      execFileSync("git",["-C",root,"rev-parse","--verify","HEAD"],{
        encoding:"utf8",timeout:5000,maxBuffer:4096,windowsHide:true,stdio:["ignore","ignore","ignore"],
      });
      return true;
    }catch{return false;}
  }
  private mobileGitPath(root:string,rawPath:string):string{
    if(isAbsolute(rawPath)||/^[a-z]:/i.test(rawPath)||rawPath.startsWith("\\\\"))throw new Error("Ожидался относительный путь внутри проекта");
    const parts=rawPath.split(/[\\/]+/).filter(Boolean);
    if(!parts.length||parts.some(part=>part==="."||part===".."||part.includes(":")||part.includes("\0")))throw new Error("Недопустимый путь Git");
    if(parts.some(part=>this.isHiddenMobileFile(part)))throw new Error("Секретные и служебные пути нельзя менять с телефона");
    const absolute=resolve(root,...parts);
    if(!isPathWithinRoot(root,absolute))throw new Error("Путь Git выходит за пределы проекта");
    return relative(root,absolute).split(sep).join("/");
  }
  private mobileGitStatus(sessionId:string,userId:number){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const gitRoot=this.gitRoot(root);
    const tokens=this.gitOutput(gitRoot,["status","--porcelain=v1","--branch","--untracked-files=normal","-z"],512*1024).split("\0");
    const first=(tokens.shift()??"").split(/\r?\n/);
    const header=(first.shift()??"").replace(/\r$/g,"");
    const branch=header.startsWith("## ")?header.slice(3).split("...")[0]?.split(" [")[0]?.slice(0,160)??"":"";
    const lines=[...first,...tokens].filter(Boolean);
    const changes:Array<{code:string;indexStatus:string;worktreeStatus:string;path:string;previousPath?:string}> = [];
    for(let i=0;i<lines.length&&changes.length<250;i++){
      const line=lines[i]!;
      const code=line.slice(0,2);
      const path=line.slice(3);
      const renamed=/[RC]/.test(code);
      const previousPath=renamed?lines[++i]:undefined;
      changes.push({
        code:code.trim()||"??",indexStatus:code[0]??" ",worktreeStatus:code[1]??" ",
        path:path.slice(0,1200),previousPath:previousPath?.slice(0,1200),
      });
    }
    const branches=this.gitOutput(gitRoot,["branch","--format=%(refname:short)"],128*1024).split(/\r?\n/).map(value=>value.trim()).filter(Boolean).slice(0,250);
    return {project:name,branch,branches,clean:changes.length===0,changes,checkedAt:Date.now()};
  }
  private mobileGitDiff(sessionId:string,userId:number,args:Record<string,unknown>={}){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const gitRoot=this.gitRoot(root);
    const paths:string[]=[];
    if(typeof args.path==="string")paths.push(this.mobileGitPath(root,args.path));
    if(typeof args.previousPath==="string")paths.push(this.mobileGitPath(root,args.previousPath));
    const pathArgs=paths.length?["--",...new Set(paths)]:[];
    const safeArgs=["--literal-pathspecs","diff","--no-ext-diff","--no-textconv","--no-color","--unified=3"];
    const unstaged=this.gitOutput(gitRoot,[...safeArgs,...pathArgs]);
    const staged=this.gitOutput(gitRoot,[...safeArgs,"--cached",...pathArgs]);
    return {project:name,unstaged,staged,checkedAt:Date.now()};
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
        let archivedSessions:CodexThreadSummary[]=[];
        let archiveAvailable=acp.isConnected;
        if(archiveAvailable){
          try{archivedSessions=await this.archivedCatalogue(chatId);}
          catch(error){
            archiveAvailable=false;
            log.warn("Could not read Codex archive:",(error as Error).message);
          }
        }
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
          sessions:threads.slice(0,500).map(t=>({
            id:t.id,title:(t.name||t.preview||"Новый сеанс").slice(0,180),
            cwd:t.cwd||"",updatedAt:t.recencyAt||t.updatedAt||t.createdAt||0,
            source:threadSourceKind(t)||"unknown",
            archived:false,
            busy:controlled.some(c=>c.sessionId===t.id&&c.busy),
            queue:controlled.find(c=>c.sessionId===t.id)?.queueLength||0,
            progress:controlled.find(c=>c.sessionId===t.id)?.progress,
          })),
          archivedSessions:archiveAvailable?archivedSessions.slice(0,500).map(t=>({
            id:t.id,title:(t.name||t.preview||"Без названия").slice(0,180),
            cwd:t.cwd||"",updatedAt:t.recencyAt||t.updatedAt||t.createdAt||0,
            source:threadSourceKind(t)||"unknown",archived:true,busy:false,queue:0,
          })):[],
          archiveAvailable,
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
        const includeTools=args.includeTools===true;
        const cacheKey=id+":"+(includeTools?"tools":"chat");
        // Avoid re-reading multi-megabyte rollout logs every six seconds.
        // A manual refresh still checks the file's current size/mtime first.
        const stat=statSyncSafe(path);
        const cached=this.historyCache.get(cacheKey);
        if(cached&&cached.size===stat.size&&cached.mtimeMs===stat.mtimeMs)return cached.result;
        const key=cacheKey+":"+stat.size+":"+stat.mtimeMs;
        const existing=this.historyInflight.get(key);
        if(existing)return existing;
        const pending=(async()=>{
          const entries=(await readConversationHistoryAsync(path,40,32*1024*1024,includeTools)).map(e=>({
            role:e.role,text:e.text,timestamp:e.timestamp,tool:e.tool,
          }));
          const refs=t.cwd?await this.screenshots.scan(id,path,t.cwd):[];
          const result={entries,images:refs,project:t.cwd||""};
          // The agent may append to the log during this read. Don't store
          // a stale transcript under a newer file revision.
          const after=statSyncSafe(path);
          if(after.size===stat.size&&after.mtimeMs===stat.mtimeMs){
            this.historyCache.set(cacheKey,{...stat,result});
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
        if(await this.isArchivedThread(id,chatId))throw new Error("Сначала восстановите сеанс из архива");
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
            if(await this.isArchivedThread(id,chatId))throw new Error("Сначала восстановите сеанс из архива");
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

export function startMiniAppAgent(deps:AgentDeps,shared?:MiniAppAgent):MiniAppAgent|undefined{
  const url=(process.env.TMA_GATEWAY_URL||"").trim(),secret=(process.env.TMA_AGENT_TOKEN||"").trim();
  if(!url&&!secret)return undefined;
  if(!url||!secret){log.warn("TMA disabled: specify both TMA_GATEWAY_URL and TMA_AGENT_TOKEN");return undefined;}
  const agent=shared??new MiniAppAgent(deps,url,secret);agent.start();return agent;
}
