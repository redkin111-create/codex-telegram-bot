/**
 * Windows-side outbound TMA agent. Reuses the SAME AcpClient/RuntimeRegistry as
 * the Telegram bot and never listens on the PC's public network interface.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AcpClient } from "../acp/client.js";
import type { CodexThreadSummary, CodexProjectSummary, CodexRateLimitWindow, CodexThreadGoalStatus, CodexReviewTarget } from "../acp/codex-protocol.js";
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

const execFile=promisify(execFileCallback);
const MAX_MOBILE_TERMINAL_OUTPUT=64*1024;
const MAX_MOBILE_PTY_BUFFER=512*1024;
const MAX_MOBILE_PTY_READ=64*1024;
const MOBILE_PTY_IDLE_MS=30*60*1000;
import { normalizeMobileIntegrations, normalizeMobileMcpServers, normalizePluginInstallResult } from "../mobile/integrations.js";
import { gitRemoteTarget } from "../mobile/git-remotes.js";
import { SttService } from "../app/stt.js";

const log=createLogger("tma:agent");
const MAX_IMG=3*1024*1024;
const MAX_MOBILE_AUDIO=5*1024*1024;
const MOBILE_AUDIO_TYPES:Record<string,{extension:string;kind:string}>={
  "audio/webm":{extension:".webm",kind:"webm"},"audio/ogg":{extension:".ogg",kind:"ogg"},
  "audio/mpeg":{extension:".mp3",kind:"mp3"},"audio/mp4":{extension:".mp4",kind:"mp4"},
  "audio/wav":{extension:".wav",kind:"wav"},"audio/x-wav":{extension:".wav",kind:"wav"},
  "audio/aac":{extension:".aac",kind:"aac"},"audio/3gpp":{extension:".3gp",kind:"3gpp"},
};
function asciiAt(bytes:Buffer,offset:number,text:string):boolean{
  return bytes.length>=offset+text.length&&bytes.toString("ascii",offset,offset+text.length)===text;
}
function mobileAudioSignatureMatches(bytes:Buffer,kind:string):boolean{
  switch(kind){
    case "webm":return bytes.length>=4&&bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3;
    case "ogg":return asciiAt(bytes,0,"OggS");
    case "wav":return asciiAt(bytes,0,"RIFF")&&asciiAt(bytes,8,"WAVE");
    case "mp3":return asciiAt(bytes,0,"ID3")||(bytes.length>=4&&bytes[0]===0xff!&&(bytes[1]!&0xe0)===0xe0);
    case "mp4":return asciiAt(bytes,4,"ftyp");
    case "3gpp":return asciiAt(bytes,4,"ftyp")&&bytes.toString("ascii",8,12).startsWith("3gp");
    case "aac":return bytes.length>=2&&bytes[0]===0xff&&(bytes[1]!&0xf6)===0xf0;
    default:return false;
  }
}
function decodeMobileAudio(args:Record<string,unknown>):{bytes:Buffer;mimeType:string;filename:string}{
  const mimeType=argumentString(args,"mimeType",80).toLowerCase();
  const audioType=MOBILE_AUDIO_TYPES[mimeType];
  if(!audioType)throw new Error("Неподдерживаемый формат аудио");
  const encoded=argumentString(args,"data",Math.ceil(MAX_MOBILE_AUDIO/3)*4);
  if(encoded.length%4!==0)throw new Error("Некорректные данные аудио");
  const bytes=Buffer.from(encoded,"base64");
  if(bytes.length===0||bytes.toString("base64")!==encoded)throw new Error("Некорректные данные аудио");
  if(bytes.length>MAX_MOBILE_AUDIO)throw new Error("Аудио должно быть не больше 5 МБ");
  if(!mobileAudioSignatureMatches(bytes,audioType.kind))throw new Error("Содержимое не похоже на аудио указанного формата");
  return {bytes,mimeType,filename:"codex-mobile-audio"+audioType.extension};
}
function mobileReviewTarget(value:unknown):CodexReviewTarget{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Укажите, что нужно проверить");
  const target=value as Record<string,unknown>;
  if(target.type==="uncommittedChanges")return {type:"uncommittedChanges"};
  if(target.type==="baseBranch"){
    if(typeof target.branch!=="string")throw new Error("Укажите базовую ветку для ревью");
    const branch=target.branch.trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)||branch.includes("..")||branch.includes("//")||branch.endsWith("/"))
      throw new Error("Недопустимое имя базовой ветки для ревью");
    return {type:"baseBranch",branch};
  }
  if(target.type==="commit"){
    if(typeof target.sha!=="string"||!/^[a-f0-9]{7,64}$/i.test(target.sha.trim()))throw new Error("Укажите корректный SHA коммита для ревью");
    const sha=target.sha.trim();
    if(target.title!==undefined&&typeof target.title!=="string")throw new Error("Название коммита должно быть текстом");
    const title=typeof target.title==="string"?target.title.trim().slice(0,180):undefined;
    return {type:"commit",sha,...(title?{title}:{})};
  }
  if(target.type==="custom"){
    if(typeof target.instructions!=="string")throw new Error("Укажите инструкции для ревью");
    const instructions=target.instructions.trim();
    if(!instructions||instructions.length>1000)throw new Error("Инструкции для ревью должны содержать от 1 до 1000 символов");
    return {type:"custom",instructions};
  }
  throw new Error("Неизвестный тип ревью");
}
function selectedMobileSkillName(text:string):string|undefined{
  const match=/^\$([\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159})(?=$|[\t \r\n])/u.exec(text.trim());
  return match?.[1];
}
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

export interface MobilePtyProcess {
  write(data:string):void;
  resize(cols:number,rows:number):void;
  kill():void;
  onData(listener:(data:string)=>void):{dispose():void};
  onExit(listener:(event:{exitCode:number;signal?:number})=>void):{dispose():void};
}
export interface MobilePtyOptions {
  name:string;cols:number;rows:number;cwd:string;encoding:"utf8";env:NodeJS.ProcessEnv;
}
export type MobilePtyFactory=(shell:string,args:string[],options:MobilePtyOptions)=>MobilePtyProcess;
interface MobilePtyRecord {
  terminalId:string;ownerId:number;sessionId:string;shell:string;pty:MobilePtyProcess;
  output:string;outputStart:number;totalChars:number;exited:boolean;exitCode:number|null;closed:boolean;
  expiry?:NodeJS.Timeout;dataSubscription?:{dispose():void};exitSubscription?:{dispose():void};
}
export interface AgentDeps { cfg:AppConfig; acp:AcpClient; registry:RuntimeRegistry; stt?:Pick<SttService,"enabled"|"transcribe">; mobilePtyFactory?:MobilePtyFactory; }
export type MobileLocalOperation = "capabilities" | "searchThreads" | "listMoreThreads" | "latestEditableTurn" | "editAndRetry" | "transcribeAudio" | "terminalExec" | "terminalStart" | "terminalRead" | "terminalInput" | "terminalResize" | "terminalStop" | "listBackgroundTerminals" | "stopBackgroundTerminal" | "setModel" | "setMode" | "setReasoning" | "setGoal" | "clearGoal" | "setSkillEnabled" | "mcpOAuthLogin" | "steer" | "forkThread" | "compactThread" | "reviewThread" | "archiveThread" | "unarchiveThread" | "renameThread" | "deleteThread" | "installPlugin" | "uninstallPlugin" | "createWorktree" | "files" | "readFile" | "readImage" | "writeFile" | "createFile" | "gitStatus" | "gitDiff" | "gitStage" | "gitUnstage" | "gitCommit" | "gitCreateBranch" | "gitSwitchBranch" | "gitTrackRemoteBranch" | "gitFetch" | "gitPush";
export interface MobileLocalJob { op:MobileLocalOperation; userId:number; args:Record<string,unknown>; }
export class MiniAppAgent {
  private readonly abort=new AbortController();
  private readonly stt:Pick<SttService,"enabled"|"transcribe">;
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
  private readonly mobilePtys=new Map<string,MobilePtyRecord>();
  private loopPromise:Promise<void>|undefined;
  constructor(private readonly deps:AgentDeps,gatewayUrl?:string,secret?:string){
    this.stt=deps.stt??new SttService({apiUrl:deps.cfg.sttApiUrl,apiKey:deps.cfg.sttApiKey,model:deps.cfg.sttModel,language:deps.cfg.sttLanguage});
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
  stop():void{this.abort.abort();for(const terminal of this.mobilePtys.values())this.disposeMobilePty(terminal);this.mobilePtys.clear();}
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
    if(job.op!=="capabilities"&&job.op!=="searchThreads"&&job.op!=="listMoreThreads"&&!sessionId)throw new Error("Сначала выберите сеанс Codex");
    const runtime=sessionId?registry.runtimeForSession(chatId,sessionId):undefined;
    switch(job.op){
      case "searchThreads":{
        const query=argumentString(args,"query",120).trim();
        if(query.length<2)return {sessions:[],nextCursor:undefined};
        const cursor=args.cursor===undefined?undefined:argumentString(args,"cursor",2048);
        let cwd:string|undefined;
        if(args.cwd!==undefined){
          if(typeof args.cwd!=="string"||args.cwd.length>700)throw new Error("Неверная папка проекта для поиска");
          if(args.cwd.trim())cwd=(await this.project(args.cwd.trim(),chatId)).cwd;
        }
        const archived=args.archived===true;
        const page=await acp.listThreadsPage({
          limit:100,sortKey:"recency_at",sortDirection:"desc",
          sourceKinds:["cli","vscode","appServer"],archived,searchTerm:query,
          ...(cursor?{cursor}:{}),...(cwd?{cwd}:{}),
        });
        const visible=page.threads.filter(thread=>!thread.ephemeral&&
          (!this.telegramSessions.getOwner(thread.id)||this.telegramSessions.getOwner(thread.id)?.chatId===chatId)&&
          ["cli","vscode","appServer"].includes(threadSourceKind(thread)??""));
        const catalogue=archived
          ? this.archivedThreads.get(chatId)??new Map<string,CodexThreadSummary>()
          : this.knownThreads.get(chatId)??new Map<string,CodexThreadSummary>();
        for(const thread of [...visible].reverse()){
          catalogue.delete(thread.id);
          catalogue.set(thread.id,thread);
          if(archived)this.knownThreads.get(chatId)?.delete(thread.id);
          else this.archivedThreads.get(chatId)?.delete(thread.id);
        }
        while(catalogue.size>500){
          const oldest=catalogue.keys().next().value;
          if(oldest===undefined)break;
          if(!archived&&oldest===this.selected.get(chatId)){
            const selected=catalogue.get(oldest);
            catalogue.delete(oldest);
            if(selected)catalogue.set(oldest,selected);
          }else catalogue.delete(oldest);
        }
        if(archived)this.archivedThreads.set(chatId,catalogue);
        else this.knownThreads.set(chatId,catalogue);
        const sessions=visible.map(thread=>{
          const current=registry.runtimeForSession(chatId,thread.id);
          return {
            id:thread.id,title:(thread.name||thread.preview||"Новый сеанс").slice(0,180),cwd:thread.cwd||"",
            updatedAt:thread.recencyAt||thread.updatedAt||thread.createdAt||0,
            source:threadSourceKind(thread)||"unknown",archived,busy:Boolean(current?.isBusy),
            queue:current?.queueLength||0,liveStatus:"unknown",liveLabel:"Статус неизвестен",
          };
        });
        return {sessions,nextCursor:page.nextCursor};
      }
      case "listMoreThreads":{
        const offset=args.offset;
        if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0||offset>100_000)throw new Error("Неверное место продолжения списка сеансов");
        let cwd:string|undefined;
        if(args.cwd!==undefined){
          if(typeof args.cwd!=="string"||args.cwd.length>700)throw new Error("Неверная папка проекта для списка сеансов");
          if(args.cwd.trim())cwd=(await this.project(args.cwd.trim(),chatId)).cwd;
        }
        const archived=args.archived===true;
        const threads=archived?await this.archivedCatalogue(chatId):(await this.catalogue(chatId)).threads;
        const visible=threads.filter(thread=>!cwd||thread.cwd===cwd);
        const page=visible.slice(offset,offset+100);
        const sessions=page.map(thread=>{
          const current=archived?undefined:registry.runtimeForSession(chatId,thread.id);
          return {
            id:thread.id,title:(thread.name||thread.preview||(archived?"Без названия":"Новый сеанс")).slice(0,180),cwd:thread.cwd||"",
            updatedAt:thread.recencyAt||thread.updatedAt||thread.createdAt||0,
            source:threadSourceKind(thread)||"unknown",archived,busy:Boolean(current?.isBusy),
            queue:current?.queueLength||0,liveStatus:"unknown",liveLabel:"Статус неизвестен",
          };
        });
        const nextOffset=offset+page.length;
        return {sessions,...(nextOffset<visible.length?{nextOffset}:{})};
      }
      case "latestEditableTurn":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.readMobileLatestEditableTurn!=="function")throw new Error("Эта версия Codex не поддерживает редактирование последнего запроса");
        const turn=await acp.readMobileLatestEditableTurn(sessionId);
        return turn??{editable:false,reason:"Последний запрос Codex не найден"};
      }
      case "editAndRetry":{
        const turnId=argumentString(args,"turnId",128);
        const message=argumentString(args,"text",16000).trim();
        if(!message)throw new Error("Введите текст запроса для повтора");
        const requestId=argumentString(args,"requestId",80);
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор запроса");
        const fingerprint=tmaPromptFingerprint("edit-and-retry:"+turnId+":"+message,[]);
        const key=chatId+":"+sessionId+":"+requestId;
        const existing=this.sends.get(key);
        if(existing){
          if(existing.fingerprint!==fingerprint)throw new Error("Нельзя переиспользовать ID для другого задания");
          return existing.promise;
        }
        let dispatched=false;
        let reserved=false;
        const pending=(async()=>{
          try{
            if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
            await this.thread(sessionId,chatId);
            const recorded=this.promptJournal.lookup(key,fingerprint);
            if(recorded.found)return recorded.result;
            if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
            if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
            if(!runtime)throw new Error("Сначала подключите этот сеанс Codex");
            if(runtime.isBusy||runtime.queueLength>0||(typeof acp.hasActiveTurn==="function"&&acp.hasActiveTurn(sessionId)))throw new Error("Дождитесь завершения текущей задачи и очереди перед редактированием");
            if(typeof acp.readMobileLatestEditableTurn!=="function"||typeof acp.revertMobileThread!=="function")throw new Error("Эта версия Codex не поддерживает редактирование последнего запроса");
            const latest=await acp.readMobileLatestEditableTurn(sessionId);
            if(!latest||latest.turnId!==turnId)throw new Error("Последний запрос Codex изменился. Обновите его перед редактированием");
            if(!latest.editable)throw new Error("Последний запрос нельзя безопасно редактировать с телефона");
            const controller=registry.controller(chatId);
            if(controller.foreground().sessionId!==sessionId)await controller.switchTo(sessionId);
            const current=registry.runtimeForSession(chatId,sessionId);
            if(!current||current.isBusy||current.queueLength>0||(typeof acp.hasActiveTurn==="function"&&acp.hasActiveTurn(sessionId)))throw new Error("Сеанс изменил состояние. Обновите его перед редактированием");
            this.promptJournal.reserve(key,fingerprint);
            reserved=true;
            dispatched=true;
            await acp.revertMobileThread!(sessionId,turnId);
            this.historyCache.delete(sessionId+":chat");
            this.historyCache.delete(sessionId+":tools");
            const input=textPrompt(message);
            input.skillNames=latest.skillNames;
            const result=await registry.submitPrompt(chatId,input);
            const answer={result:result.kind==="submitted"?result.outcome:result.kind};
            this.promptJournal.complete(key,answer);
            return answer;
          }catch(error){
            if(dispatched)this.promptJournal.uncertain(key);
            else if(reserved)this.promptJournal.clearBeforeDispatch(key);
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
      case "transcribeAudio":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!this.stt.enabled)throw new Error("Распознавание речи не настроено на этом компьютере");
        const audio=decodeMobileAudio(args);
        let transcript:string;
        try{
          transcript=await this.stt.transcribe(audio.bytes,audio.mimeType,audio.filename);
        }catch{
          throw new Error("Не удалось распознать аудио. Проверьте настройки и доступность STT-сервиса");
        }
        const text=transcript.trim();
        if(text.length>16000)throw new Error("Распознанный текст слишком длинный");
        return {text};
      }
      case "terminalExec":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя запускать команду в архивном сеансе");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        const command=argumentString(args,"command",4000).trim();
        if(!command||command.includes("\0"))throw new Error("Введите корректную команду");
        return this.mobileTerminalCommand(root,command);
      }
      case "terminalStart":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя запускать терминал в архивном сеансе");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        return this.startMobilePty(chatId,sessionId,root);
      }
      case "terminalRead":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const terminal=this.mobilePtyFor(chatId,sessionId,args);
        const offset=args.offset===undefined?0:args.offset;
        if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0||offset>terminal.totalChars)throw new Error("Неверная позиция терминального вывода");
        this.touchMobilePty(terminal);
        const start=Math.max(offset,terminal.outputStart);
        const output=terminal.output.slice(start-terminal.outputStart,start-terminal.outputStart+MAX_MOBILE_PTY_READ);
        return {terminalId:terminal.terminalId,output,nextOffset:start+output.length,truncated:offset<terminal.outputStart,
          exited:terminal.exited||terminal.closed,exitCode:terminal.exitCode};
      }
      case "terminalInput":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя отправлять команды в архивный сеанс");
        const terminal=this.mobilePtyFor(chatId,sessionId,args);
        if(typeof args.data!=="string"||args.data.length>16*1024)throw new Error("Слишком большой ввод терминала");
        if(terminal.exited||terminal.closed)throw new Error("Терминал завершён");
        terminal.pty.write(args.data);
        this.touchMobilePty(terminal);
        return {written:true};
      }
      case "terminalResize":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя изменять терминал архивного сеанса");
        const terminal=this.mobilePtyFor(chatId,sessionId,args);
        const {cols,rows}=args;
        if(typeof cols!=="number"||typeof rows!=="number"||!Number.isInteger(cols)||!Number.isInteger(rows)||cols<20||cols>240||rows<5||rows>100){
          throw new Error("Неверный размер терминала");
        }
        if(terminal.exited||terminal.closed)throw new Error("Терминал завершён");
        terminal.pty.resize(cols,rows);
        this.touchMobilePty(terminal);
        return {resized:true};
      }
      case "terminalStop":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const terminal=this.mobilePtyFor(chatId,sessionId,args);
        if(!terminal.exited&&!terminal.closed){terminal.closed=true;terminal.pty.kill();}
        this.touchMobilePty(terminal);
        return {stopped:true};
      }
      case "listBackgroundTerminals":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.listMobileBackgroundTerminals!=="function")throw new Error("Эта версия Codex не поддерживает список фоновых процессов");
        return {items:await acp.listMobileBackgroundTerminals(sessionId)};
      }
      case "stopBackgroundTerminal":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.terminateMobileBackgroundTerminal!=="function")throw new Error("Эта версия Codex не поддерживает остановку фоновых процессов");
        const processId=argumentString(args,"processId",128);
        if(!/^[a-z0-9._-]{1,128}$/i.test(processId))throw new Error("Выберите фоновый процесс из списка сеанса Codex");
        await acp.terminateMobileBackgroundTerminal(sessionId,processId);
        return {stopped:true,processId};
      }
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
      case "reviewThread":{
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Восстановите сеанс из архива перед запуском ревью");
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(runtime?.isBusy||acp.hasActiveTurn(sessionId))throw new Error("Нельзя запускать ревью, пока Codex выполняет задачу");
        if(args.delivery!==undefined&&args.delivery!=="inline")throw new Error("Мобильное ревью запускается в выбранном сеансе");
        const target=mobileReviewTarget(args.target);
        const result=await acp.reviewThread(sessionId,target,"inline");
        if(result.reviewThreadId!==sessionId)throw new Error("Codex вернул другой сеанс для встроенного ревью");
        return {started:true,reviewThreadId:sessionId,turnId:result.turn.id};
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
      case "deleteThread":{
        const thread=await this.thread(sessionId,chatId);
        if(!await this.isArchivedThread(sessionId,chatId))throw new Error("Удалять можно только сеанс из архива");
        if(runtime?.isBusy||runtime?.queueLength||((typeof acp.hasActiveTurn==="function")&&acp.hasActiveTurn(sessionId)))
          throw new Error("Нельзя удалить сеанс, пока Codex выполняет задачу или в нём есть очередь");
        if(runtime)throw new Error("Сначала отключите архивный сеанс от текущего управления Codex");
        if(typeof registry.ownerChatForSession==="function"&&registry.ownerChatForSession(sessionId)!==undefined)
          throw new Error("Нельзя удалить сеанс, пока им управляет Telegram или другой клиент");
        if([...this.mobilePtys.values()].some(item=>item.ownerId===chatId&&item.sessionId===sessionId&&!item.exited&&!item.closed))
          throw new Error("Сначала остановите терминал этого сеанса");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.deleteThread!=="function")throw new Error("Эта версия Codex не поддерживает удаление сеансов через app-server");
        await acp.deleteThread(sessionId);
        this.knownThreads.get(chatId)?.delete(sessionId);
        this.archivedThreads.get(chatId)?.delete(sessionId);
        this.ownThreads.delete(sessionId);
        this.historyCache.delete(sessionId+":chat");
        this.historyCache.delete(sessionId+":tools");
        this.historyInflight.delete(sessionId+":chat");
        this.historyInflight.delete(sessionId+":tools");
        this.telegramSessions.removeIfOwnedBy(sessionId,chatId);
        if(this.selected.get(chatId)===sessionId)this.selected.delete(chatId);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,deleted:true,name:thread.name};
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
            const skillName=selectedMobileSkillName(text);
            if(skillName)input.skillNames=[skillName];
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
        let mcpInventory:unknown=acp.availableMcpServers;
        let mcpServersAvailable=acp.isConnected;
        if(acp.isConnected&&integrationThread&&typeof acp.listMobileMcpServers==="function"){
          try{mcpInventory=await acp.listMobileMcpServers(sessionId);mcpServersAvailable=true;}
          catch{mcpInventory=[];mcpServersAvailable=false;}
        }
        const skills=integrationThread?.cwd&&acp.isConnected&&typeof acp.listMobileSkills==="function"
          ? await acp.listMobileSkills(integrationThread.cwd).catch(()=>acp.availableSkills)
          : acp.availableSkills;
        const skillNameCounts=new Map<string,number>();
        for(const skill of skills)skillNameCounts.set(skill.name,(skillNameCounts.get(skill.name)??0)+1);
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
          skills:skills.slice(0,100).map(s=>({name:s.name.slice(0,160),description:s.description?.slice(0,500),
            enabled:s.enabled!==false,scope:s.scope,canToggle:(s.scope==="user"||s.scope==="repo")&&skillNameCounts.get(s.name)===1,
            invokable:s.enabled!==false&&skillNameCounts.get(s.name)===1})),
          mcpServersAvailable,mcpServers:normalizeMobileMcpServers(mcpInventory),
          plugins:integrations.plugins,pluginCatalogAvailable:integrations.pluginCatalogAvailable,
          apps:integrations.apps,appsAvailable:integrations.appsAvailable,
          account:account.account?{type:account.account.type,email:account.account.email?.slice(0,200),plan:account.account.planType?.slice(0,100)}:undefined,
          limits,subagents,checkedAt:Date.now(),
          goal,goalAvailable,
        };
      }
      case "mcpOAuthLogin":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя запускать вход из архивного сеанса");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.listMobileMcpServers!=="function"||typeof acp.startMobileMcpOAuthLogin!=="function"){
          throw new Error("Эта версия Codex не поддерживает вход в MCP с телефона");
        }
        this.requireIdleMobileRuntime(sessionId,chatId);
        const name=argumentString(args,"name",120).trim();
        if(!name)throw new Error("Выберите MCP-сервер из настроек Codex");
        const servers=await acp.listMobileMcpServers(sessionId);
        const server=servers.find(entry=>entry.name===name);
        if(!server)throw new Error("MCP-сервер не найден в выбранном сеансе");
        const loginRequired=server.runtimeStatus==="authenticationRequired"||server.authStatus==="needs_auth"||server.authStatus==="notLoggedIn";
        if(!loginRequired)throw new Error("Этот MCP-сервер сейчас не сообщает о необходимости входа");
        return await acp.startMobileMcpOAuthLogin(name,sessionId);
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
      case "setSkillEnabled":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять навыки из архивного сеанса");
        const thread=await this.thread(sessionId,chatId);
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof args.enabled!=="boolean")throw new Error("Укажите новое состояние навыка");
        const name=argumentString(args,"name",160).trim();
        if(!name)throw new Error("Выберите навык из списка Codex");
        if(typeof acp.setMobileSkillEnabled!=="function")throw new Error("Эта версия Codex не поддерживает изменение навыков");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const enabled=await acp.setMobileSkillEnabled(name,args.enabled,thread.cwd);
        return {name,enabled};
      }
      case "createWorktree":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const source=await this.thread(sessionId,chatId);
        if(!source.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя создать рабочую копию из архивного сеанса");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(typeof acp.hasActiveTurn==="function"&&acp.hasActiveTurn(sessionId))throw new Error("Дождитесь завершения текущей задачи Codex");
        const branchName=argumentString(args,"branchName",100).trim();
        if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(branchName)||branchName.includes("..")||branchName.includes("//")||branchName.endsWith("/")||branchName.endsWith(".")||branchName.includes("@{")||branchName.includes("\\"))
          throw new Error("Недопустимое имя ветки");
        const {root}=this.mobileRoot(sessionId,chatId);
        const gitRoot=this.gitRoot(root);
        try{this.gitOutput(gitRoot,["check-ref-format","--branch",branchName],4096);}
        catch{throw new Error("Недопустимое имя ветки");}
        if(this.mobileGitStatus(sessionId,chatId).branches.includes(branchName))throw new Error("Такая локальная ветка уже существует");
        if(!this.gitHasHead(gitRoot))throw new Error("Сначала создайте первый коммит в проекте");
        const dataRoot=realpathSync.native(cfg.dataDir);
        const worktreesRoot=resolve(dataRoot,"codex-mobile-worktrees");
        if(existsSync(worktreesRoot)){
          const existing=lstatSync(worktreesRoot);
          if(existing.isSymbolicLink()||!existing.isDirectory())throw new Error("Папка мобильных рабочих копий недоступна");
        }else mkdirSync(worktreesRoot);
        const actualWorktreesRoot=realpathSync.native(worktreesRoot);
        if(!isPathWithinRoot(dataRoot,actualWorktreesRoot)||isPathWithinRoot(gitRoot,actualWorktreesRoot))
          throw new Error("Папка рабочих копий должна находиться вне проекта");
        const branchSlug=branchName.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64)||"worktree";
        const worktreePath=resolve(actualWorktreesRoot,`${basename(gitRoot)}-${branchSlug}-${randomBytes(5).toString("hex")}`);
        if(!isPathWithinRoot(actualWorktreesRoot,worktreePath)||existsSync(worktreePath))throw new Error("Не удалось подготовить отдельную папку рабочей копии");
        this.gitMutation(gitRoot,["worktree","add","-b",branchName,worktreePath,"HEAD"],120_000);
        let newSessionId:string;
        try{
          newSessionId=await acp.newSession(worktreePath);
          if(!/^[a-z0-9_-]{8,128}$/i.test(newSessionId))throw new Error("Codex вернул недопустимый ID нового сеанса");
        }
        catch(error){
          try{
            const actual=realpathSync.native(worktreePath);
            if(isPathWithinRoot(actualWorktreesRoot,actual)&&resolve(actual).toLowerCase()===resolve(worktreePath).toLowerCase()){
              this.gitMutation(gitRoot,["worktree","remove","--force",actual],120_000);
              this.gitMutation(gitRoot,["branch","-D","--",branchName]);
            }
          }catch{/* Preserve the original Codex error; cleanup is limited to the new generated path. */}
          throw error;
        }
        const now=Date.now()/1000;
        const created:CodexThreadSummary={...source,id:newSessionId,name:`${branchName} · рабочая копия`,cwd:worktreePath,
          source:"appServer",createdAt:now,updatedAt:now,recencyAt:now,parentThreadId:sessionId};
        this.telegramSessions.recordMobile(newSessionId,chatId,worktreePath,branchName);
        this.ownThreads.set(newSessionId,created);
        const known=this.knownThreads.get(chatId)??new Map<string,CodexThreadSummary>();
        known.set(newSessionId,created);
        this.knownThreads.set(chatId,known);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        this.selected.set(chatId,newSessionId);
        return {sessionId:newSessionId,branch:branchName,path:worktreePath};
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
      case "readImage":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileReadImage(sessionId,chatId,argumentString(args,"path",1200));
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
      case "gitSwitchBranch":
      case "gitTrackRemoteBranch":
      case "gitFetch":
      case "gitPush":{
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
        if(job.op==="gitTrackRemoteBranch"){
          const remoteBranch=argumentString(args,"remoteBranch",200).trim();
          const status=this.mobileGitStatus(sessionId,chatId);
          if(!status.remoteBranches.includes(remoteBranch))throw new Error("Удалённая ветка не найдена среди уже загруженных ссылок");
          const remotes=this.gitOutput(gitRoot,["remote"],32*1024).split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
          const remote=remotes.filter(value=>remoteBranch.startsWith(value+"/")).sort((a,b)=>b.length-a.length)[0];
          if(!remote)throw new Error("Не удалось определить удалённый репозиторий ветки");
          const branch=remoteBranch.slice(remote.length+1);
          this.gitMutation(gitRoot,["check-ref-format","--branch",branch]);
          if(this.gitRefExists(gitRoot,"refs/heads/"+branch))throw new Error("Локальная ветка с таким именем уже существует");
          this.gitMutation(gitRoot,["switch","--track","--no-guess","--create",branch,"refs/remotes/"+remoteBranch]);
          return {project:name,branch,upstream:remoteBranch};
        }
        if(job.op==="gitFetch"){
          const remoteName=argumentString(args,"remoteName",80).trim();
          this.requireMobileGitRemote(gitRoot,remoteName,"fetch");
          await this.mobileGitRemoteCommand(gitRoot,["fetch","--prune","--no-recurse-submodules",remoteName],"fetch");
          return {remoteName,fetched:true};
        }
        if(job.op==="gitPush"){
          const remoteName=argumentString(args,"remoteName",80).trim();
          this.requireMobileGitRemote(gitRoot,remoteName,"push");
          const branch=this.gitOutput(gitRoot,["branch","--show-current"],4096).trim();
          if(!branch)throw new Error("Сначала переключитесь на обычную ветку в Codex Desktop");
          this.gitOutput(gitRoot,["check-ref-format","--branch",branch],4096);
          await this.mobileGitRemoteCommand(gitRoot,["push","--porcelain",remoteName,`HEAD:refs/heads/${branch}`],"push");
          return {remoteName,branch};
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
  private async startMobilePty(ownerId:number,sessionId:string,cwd:string){
    const existing=[...this.mobilePtys.values()].find(item=>item.ownerId===ownerId&&item.sessionId===sessionId&&!item.exited&&!item.closed);
    if(existing){this.touchMobilePty(existing);return {terminalId:existing.terminalId,shell:existing.shell,reused:true,exited:false};}
    for(const item of this.mobilePtys.values())if(item.ownerId===ownerId&&item.sessionId===sessionId){
      this.mobilePtys.delete(item.terminalId);this.disposeMobilePty(item);
    }
    let factory=this.deps.mobilePtyFactory;
    if(!factory){
      try{factory=(await import("@homebridge/node-pty-prebuilt-multiarch")).spawn as MobilePtyFactory;}
      catch{throw new Error("Интерактивный терминал недоступен в этой установке; используйте запуск одной команды");}
    }
    const shell=process.platform==="win32"?(process.env.ComSpec||"cmd.exe"):(process.env.SHELL||"/bin/sh");
    const pty=factory(shell,[],{
      name:"xterm-256color",cols:80,rows:24,cwd,encoding:"utf8",
      env:{...process.env,TERM:"xterm-256color"},
    });
    const terminal:MobilePtyRecord={terminalId:randomUUID(),ownerId,sessionId,shell:basename(shell),pty,
      output:"",outputStart:0,totalChars:0,exited:false,exitCode:null,closed:false};
    terminal.dataSubscription=pty.onData(data=>{
      terminal.output+=data;
      terminal.totalChars+=data.length;
      if(terminal.output.length>MAX_MOBILE_PTY_BUFFER){
        const remove=terminal.output.length-MAX_MOBILE_PTY_BUFFER;
        terminal.output=terminal.output.slice(remove);
        terminal.outputStart+=remove;
      }
      if(!terminal.closed)this.touchMobilePty(terminal);
    });
    terminal.exitSubscription=pty.onExit(event=>{
      terminal.exited=true;
      terminal.exitCode=Number.isInteger(event.exitCode)?event.exitCode:null;
      if(!terminal.closed)this.touchMobilePty(terminal);
    });
    this.mobilePtys.set(terminal.terminalId,terminal);
    this.touchMobilePty(terminal);
    return {terminalId:terminal.terminalId,shell:terminal.shell,reused:false,exited:false};
  }
  private mobilePtyFor(ownerId:number,sessionId:string,args:Record<string,unknown>):MobilePtyRecord{
    const terminalId=argumentString(args,"terminalId",36);
    if(!/^[a-f0-9-]{36}$/i.test(terminalId))throw new Error("Неверный идентификатор терминала");
    const terminal=this.mobilePtys.get(terminalId);
    if(!terminal)throw new Error("Терминал не найден или соединение истекло");
    if(terminal.ownerId!==ownerId||terminal.sessionId!==sessionId)throw new Error("Доступ к терминалу запрещён");
    return terminal;
  }
  private touchMobilePty(terminal:MobilePtyRecord):void{
    if(terminal.expiry)clearTimeout(terminal.expiry);
    terminal.expiry=setTimeout(()=>{
      if(this.mobilePtys.get(terminal.terminalId)!==terminal)return;
      this.mobilePtys.delete(terminal.terminalId);
      this.disposeMobilePty(terminal);
    },MOBILE_PTY_IDLE_MS);
    terminal.expiry.unref();
  }
  private disposeMobilePty(terminal:MobilePtyRecord):void{
    if(terminal.expiry){clearTimeout(terminal.expiry);terminal.expiry=undefined;}
    if(!terminal.exited&&!terminal.closed){
      terminal.closed=true;
      try{terminal.pty.kill();}catch{/* The process may have already exited. */}
    }
    terminal.dataSubscription?.dispose();
    terminal.exitSubscription?.dispose();
  }
  private async mobileTerminalCommand(cwd:string,command:string):Promise<{
    exitCode:number|null;stdout:string;stderr:string;truncated:boolean;durationMs:number;timedOut:boolean;
  }>{
    const started=Date.now();
    const executable=process.platform==="win32"?"powershell.exe":"/bin/sh";
    const args=process.platform==="win32"?["-NoLogo","-NoProfile","-NonInteractive","-Command",command]:["-c",command];
    const limit=(value:string)=>value.length>MAX_MOBILE_TERMINAL_OUTPUT;
    const trim=(value:string)=>limit(value)?value.slice(0,MAX_MOBILE_TERMINAL_OUTPUT)+"\n[Вывод сокращён]":value;
    try{
      const result=await execFile(executable,args,{
        cwd,timeout:60_000,maxBuffer:256*1024,encoding:"utf8",windowsHide:true,
        env:{...process.env,GIT_TERMINAL_PROMPT:"0"},
      });
      const stdout=String(result.stdout),stderr=String(result.stderr);
      return {exitCode:0,stdout:trim(stdout),stderr:trim(stderr),truncated:limit(stdout)||limit(stderr),durationMs:Date.now()-started,timedOut:false};
    }catch(error){
      const failure=error as NodeJS.ErrnoException & {stdout?:string|Buffer;stderr?:string|Buffer;signal?:string};
      const stdout=String(failure.stdout??""),stderr=String(failure.stderr??"");
      const timedOut=failure.code==="ETIMEDOUT";
      return {
        exitCode:typeof failure.code==="number"?failure.code:null,stdout:trim(stdout),stderr:trim(stderr),
        truncated:limit(stdout)||limit(stderr),durationMs:Date.now()-started,timedOut,
      };
    }
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
  private mobileReadImage(sessionId:string,userId:number,rawPath:string){
    const {root,name}=this.mobileRoot(sessionId,userId);
    if(!rawPath||rawPath.split(/[\\/]+/).some(part=>this.isHiddenMobileFile(part)))throw new Error("Этот файл недоступен в мобильном просмотре");
    const absolute=this.mobilePath(root,rawPath);
    const ext=extname(absolute).toLowerCase();
    const mime=({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif"} as Record<string,string>)[ext];
    if(!mime)throw new Error("Неподдерживаемый формат изображения");
    const stat=statSync(absolute);
    if(!stat.isFile()||stat.size>MAX_IMG)throw new Error("Изображение больше 3 МБ или не является файлом");
    const bytes=readFileSync(absolute);
    const valid=mime==="image/png"?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      :mime==="image/jpeg"?bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff
      :mime==="image/webp"?bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"
      :bytes.toString("ascii",0,6)==="GIF87a"||bytes.toString("ascii",0,6)==="GIF89a";
    if(!valid)throw new Error("Содержимое файла не соответствует формату изображения");
    return {project:name,path:relative(root,absolute).split(sep).join("/"),name:basename(absolute),mime,size:stat.size,data:bytes.toString("base64")};
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
  private gitMutation(root:string,args:string[],timeout=15_000):string{
    try{
      return execFileSync("git",["--no-pager","-C",root,"-c","core.fsmonitor=false","-c","color.ui=false","--literal-pathspecs",...args],{
        encoding:"utf8",timeout,maxBuffer:512*1024,windowsHide:true,stdio:["ignore","pipe","pipe"],
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
  private mobileGitRemotes(gitRoot:string):Array<{name:string;fetchTargets:string[];pushTargets:string[]}>{
    const names=this.gitOutput(gitRoot,["remote"],32*1024).split(/\r?\n/).map(value=>value.trim())
      .filter(value=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)).slice(0,20);
    return names.map(name=>{
      const targets=(args:string[])=>{
        try{
          const urls=this.gitOutput(gitRoot,args,32*1024).split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
          if(!urls.length)return [];
          const safe=urls.map(gitRemoteTarget);
          if(safe.some(value=>!value))return [];
          return [...new Set(safe.filter((value):value is string=>Boolean(value)))].slice(0,8);
        }catch{return [];}
      };
      return {name,fetchTargets:targets(["remote","get-url","--all",name]),pushTargets:targets(["remote","get-url","--push","--all",name])};
    }).filter(remote=>remote.fetchTargets.length>0||remote.pushTargets.length>0);
  }
  private requireMobileGitRemote(gitRoot:string,name:string,direction:"fetch"|"push"):{name:string;targets:string[]}{
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name))throw new Error("Укажите удалённый репозиторий из списка проекта");
    const remote=this.mobileGitRemotes(gitRoot).find(item=>item.name===name);
    const targets=direction==="fetch"?remote?.fetchTargets:remote?.pushTargets;
    if(!targets?.length)throw new Error("Удалённый адрес отсутствует или использует неподдерживаемый протокол");
    return {name,targets};
  }
  private async mobileGitRemoteCommand(root:string,args:string[],direction:"fetch"|"push"):Promise<void>{
    try{
      await execFile("git",["--no-pager","-C",root,"-c","core.fsmonitor=false","-c","color.ui=false",...args],{
        encoding:"utf8",timeout:120_000,maxBuffer:512*1024,windowsHide:true,
        env:{...process.env,GIT_TERMINAL_PROMPT:"0"},
      });
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==="ENOENT")throw new Error("Git не установлен или не найден");
      if(code==="ETIMEDOUT")throw new Error(`Git ${direction==="fetch"?"не завершил загрузку":"не завершил отправку"} за отведённое время`);
      throw new Error(direction==="fetch"
        ? "Не удалось получить изменения. Проверьте доступ к удалённому репозиторию в Codex Desktop."
        : "Не удалось отправить ветку. Проверьте доступ к удалённому репозиторию в Codex Desktop.");
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
  private gitRefExists(root:string,ref:string):boolean{
    try{
      execFileSync("git",["-C",root,"-c","core.fsmonitor=false","show-ref","--verify","--quiet",ref],{
        timeout:5000,maxBuffer:4096,windowsHide:true,stdio:"ignore",
      });
      return true;
    }catch(error){
      const failure=error as NodeJS.ErrnoException & {status?:number};
      if(failure.status===1)return false;
      if(failure.code==="ENOENT")throw new Error("Git не установлен или не найден");
      throw new Error("Не удалось проверить ветку Git");
    }
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
    const remotes=this.mobileGitRemotes(gitRoot);
    const remoteNames=new Set(remotes.map(remote=>remote.name));
    const remoteBranches=this.gitOutput(gitRoot,["branch","--remotes","--format=%(refname:short)"],128*1024).split(/\r?\n/)
      .map(value=>value.trim()).filter(value=>value&&!value.endsWith("/HEAD")&&!remoteNames.has(value)).slice(0,250);
    return {project:name,branch,branches,remoteBranches,remotes,clean:changes.length===0,changes,checkedAt:Date.now()};
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
            const skillName=selectedMobileSkillName(message);
            if(skillName)input.skillNames=[skillName];
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
