/**
 * Windows-side outbound TMA agent. Reuses the SAME AcpClient/RuntimeRegistry as
 * the Telegram bot and never listens on the PC's public network interface.
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { structuredPatch } from "diff";
import type { AcpClient } from "../acp/client.js";
import { mobileMcpResourceTemplateParameters, resolveMobileMcpResourceTemplate } from "../acp/mobile-mcp.js";
import { CODEX_PINNED_THREAD_SECTION_ID, CODEX_PINNED_THREAD_SECTION_NAME, type CodexThreadSection, type CodexThreadSummary, type CodexThreadReadState, type CodexProjectSummary, type CodexRateLimitWindow, type CodexThreadGoalStatus, type CodexReviewTarget, type CodexMobileEditableTurn } from "../acp/codex-protocol.js";
import { REASONING_LEVELS, textPrompt, type ReasoningEffort } from "../app/types.js";
import type { RuntimeRegistry } from "../bot/registry.js";
import { isVisibleThreadForChat, threadSourceKind } from "../bot/catalog.js";
import { LiveSessionConflictError } from "../bot/session-runtime.js";
import { TmaScreenshotIndex } from "./screenshots.js";
import type { AppConfig } from "../config.js";
import { isPathWithinRoot } from "../projects/manager.js";
import { addMobileMcpConfigServer, listMobileMcpConfig, removeMobileMcpConfigServer, restartMobileCodex, setMobileMcpConfigEnabled } from "../mobile/mcp-config.js";
import { mayRequestMobileSkillNaturally, requestedMobileSkillNames, requestsBrowserMobileSkill } from "../mobile/skill-selection.js";
import { buildContentBlocks } from "../bot/prompt-content.js";
import { createLogger } from "../logger.js";
import { conversationHistorySources, MAX_CONVERSATION_HISTORY_SOURCES, readConversationHistoryAsync, searchConversationHistoryAsync } from "../sessions/history.js";
import { SessionStore } from "../sessions/store.js";
import { TelegramSessionRegistry } from "../sessions/telegram-registry.js";
import { argumentString, isTmaJob, type TmaJob, type TmaResult } from "./protocol.js";
import { parseTmaImages, tmaPromptFingerprint } from "./prompt-images.js";
import { DurablePromptJournal } from "./prompt-journal.js";
import { runMobileTerminalCommand } from "./mobile-terminal.js";
import { mobileTerminalShells, resolveMobileTerminalShell, type MobileTerminalShellId } from "./mobile-terminal-shell.js";

const execFile=promisify(execFileCallback);
type MobileScreenshotSource={threadId:string;path:string;cwd:string;endByteOffset?:number};
type MobileScreenshotCursor={sourceIndex:number;beforeOffset?:number};
function encodeMobileScreenshotCursor(sessionId:string,cursor:MobileScreenshotCursor):string{
  return Buffer.from(JSON.stringify({v:1,sessionId,...cursor})).toString("base64url");
}
function decodeMobileScreenshotCursor(raw:string,sessionId:string):MobileScreenshotCursor{
  if(raw.length>512||!/^[A-Za-z0-9_-]+$/.test(raw))throw new Error("Некорректный указатель страницы скриншотов");
  let value:unknown;
  try{value=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));}catch{throw new Error("Некорректный указатель страницы скриншотов");}
  if(!value||typeof value!=="object")throw new Error("Некорректный указатель страницы скриншотов");
  const cursor=value as Record<string,unknown>;
  if(cursor.v!==1||cursor.sessionId!==sessionId||!Number.isSafeInteger(cursor.sourceIndex)||
    (cursor.sourceIndex as number)<0||(cursor.sourceIndex as number)>=MAX_CONVERSATION_HISTORY_SOURCES||
    (cursor.beforeOffset!==undefined&&!Number.isSafeInteger(cursor.beforeOffset)))throw new Error("Некорректный указатель страницы скриншотов");
  if(cursor.beforeOffset!==undefined&&(cursor.beforeOffset as number)<0)throw new Error("Некорректный указатель страницы скриншотов");
  return {sourceIndex:cursor.sourceIndex as number,...(cursor.beforeOffset===undefined?{}:{beforeOffset:cursor.beforeOffset as number})};
}
const MAX_MOBILE_PTY_BUFFER=512*1024;
const MAX_MOBILE_PTY_READ=64*1024;
const MAX_MOBILE_CONFLICT_STAGE_BYTES=512*1024;
const MAX_MOBILE_BINARY_CONFLICT_BYTES=10*1024*1024;
const MAX_MOBILE_DOWNLOAD_BYTES=10*1024*1024;
const MAX_MOBILE_GIT_UNTRACKED_DIFF_BYTES=512*1024;
const MAX_MOBILE_GIT_DIFF_BYTES=2*1024*1024;
const MOBILE_PTY_IDLE_MS=30*60*1000;
import { normalizeMobileIntegrations, normalizeMobileMcpServers, normalizePluginInstallResult, type MobileMcpResourceSummary } from "../mobile/integrations.js";
import { normalizeMobileMarketplaces } from "../mobile/marketplaces.js";
import { gitRemoteTarget } from "../mobile/git-remotes.js";
import { normalizeThreadStatus } from "./live.js";
import { SttService } from "../app/stt.js";
import type { MobilePromptAttachment } from "../mobile/attachments.js";
import { mobileAttachmentContext } from "../mobile/attachments.js";
import { MobileSubmissionRejectedError } from "../mobile/submission.js";

const log=createLogger("tma:agent");
const MAX_IMG=3*1024*1024;
const BSK_SCREENSHOT_NAME=/^bsk-screenshot-[a-z0-9-]+\.png$/i;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_MOBILE_AUDIO=5*1024*1024;
function mobileThreadSection(section?:CodexThreadSection|null){
  if(!section)return null;
  return section.id===CODEX_PINNED_THREAD_SECTION_ID
    ? {id:section.id,name:"Закреплённые",builtIn:true}
    : {id:section.id,name:section.name,builtIn:false};
}
async function mobileSkillsRequestedByPrompt(acp:AcpClient,text:string,cwd:string):Promise<string[]>{
  const explicit=requestedMobileSkillNames(text,[]);
  if(!mayRequestMobileSkillNaturally(text))return explicit;
  if(typeof acp.listMobileSkills!=="function")throw new Error("Эта версия Codex не поддерживает список навыков для выбранной папки проекта");
  let inventory:Awaited<ReturnType<AcpClient["listMobileSkills"]>>;
  try{inventory=await acp.listMobileSkills(cwd);}
  catch{throw new Error("Не удалось проверить доступность навыков Codex. Обновите список навыков и повторите.");}
  if(requestsBrowserMobileSkill(text)&&!inventory.some(skill=>skill.name.toLowerCase()==="browser-skill")){
    throw new Error("Навык browser-skill не найден в списке Codex для этого проекта. Добавьте или включите его, затем повторите запрос.");
  }
  const names=requestedMobileSkillNames(text,inventory.map(skill=>skill.name));
  for(const name of names.filter(value=>!explicit.includes(value))){
    const matches=inventory.filter(skill=>skill.name===name);
    if(matches.length!==1)throw new Error(`Навык ${name} нельзя однозначно выбрать в этом проекте Codex`);
    if(matches[0]!.enabled===false||!matches[0]!.path)throw new Error(`Навык ${name} выключен или недоступен в этом проекте Codex`);
  }
  return names;
}
function mobileEditableTurnSummary(turn:CodexMobileEditableTurn){
  return {
    turnId:turn.turnId,
    text:turn.text,
    skillNames:turn.skillNames,
    appIds:turn.appIds,
    attachmentCount:turn.attachmentCount,
    editable:turn.editable,
  };
}
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
const MOBILE_APP_ID_PATTERN=/^[a-z0-9][a-z0-9_.:@-]{0,199}$/i;
function selectedMobileAppIds(value:unknown):string[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>3||value.some(id=>typeof id!=="string"||!MOBILE_APP_ID_PATTERN.test(id)))
    throw new Error("Выберите не больше трёх доступных приложений Codex");
  const ids=[...new Set(value as string[])];
  if(ids.length!==value.length)throw new Error("Приложение Codex выбрано несколько раз");
  return ids;
}
function statSyncSafe(path:string):{size:number;mtimeMs:number}{
  try{
    const s=statSync(path);
    return {size:s.size,mtimeMs:s.mtimeMs};
  }catch{return {size:0,mtimeMs:0};}
}
function isSafeMobilePromptAttachment(file:MobilePromptAttachment,dataDir:string):boolean{
  if(!file||!/^[a-f0-9-]{36}$/i.test(file.id)||typeof file.name!=="string"||file.name.length>120||
    typeof file.mimeType!=="string"||file.mimeType.length>100||!Number.isSafeInteger(file.size)||file.size<1||file.size>10*1024*1024)return false;
  if(typeof file.text==="string"&&!file.path)return file.text.length<=200_000;
  if(file.text!==undefined||typeof file.path!=="string")return false;
  const root=resolve(dataDir,"telegram-incoming");
  if(!isPathWithinRoot(root,file.path))return false;
  try{
    const rootInfo=lstatSync(root);
    const fileInfo=lstatSync(file.path);
    return rootInfo.isDirectory()&&!rootInfo.isSymbolicLink()&&fileInfo.isFile()&&!fileInfo.isSymbolicLink();
  }catch{return false;}
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
  terminalId:string;ownerId:number;sessionId:string;shell:string;shellId:MobileTerminalShellId;pty:MobilePtyProcess;
  output:string;outputStart:number;totalChars:number;exited:boolean;exitCode:number|null;closed:boolean;
  expiry?:NodeJS.Timeout;dataSubscription?:{dispose():void};exitSubscription?:{dispose():void};
}
interface MobileMcpResourceRef {
  ownerId:number;sessionId:string;serverName:string;uri?:string;uriTemplate?:string;expiresAt:number;
}
interface MobileEditableTurnCursorRef {
  ownerId:number;sessionId:string;cursor:string;latestTurnId:string;expiresAt:number;
}
export interface AgentDeps { cfg:AppConfig; acp:AcpClient; registry:RuntimeRegistry; stt?:Pick<SttService,"enabled"|"transcribe">; mobilePtyFactory?:MobilePtyFactory; }
export type MobileLocalOperation = "capabilities" | "listOlderScreenshots" | "listThreadReadStates" | "updateThreadReadState" | "listThreadSections" | "createThreadSection" | "renameThreadSection" | "deleteThreadSection" | "moveThreadToSection" | "searchThreads" | "searchHistory" | "listMoreThreads" | "latestEditableTurn" | "listEditableTurns" | "editAndRetry" | "transcribeAudio" | "listRealtimeVoices" | "startRealtime" | "stopRealtime" | "terminalExec" | "listTerminalShells" | "terminalStart" | "terminalRead" | "terminalInput" | "terminalResize" | "terminalStop" | "listBackgroundTerminals" | "stopBackgroundTerminal" | "setModel" | "setMode" | "setReasoning" | "setGoal" | "clearGoal" | "setSkillEnabled" | "listMcpConfig" | "addMcpConfigServer" | "setMcpConfigEnabled" | "removeMcpConfigServer" | "restartCodex" | "mcpOAuthLogin" | "callMcpTool" | "readMcpResource" | "steer" | "forkThread" | "createSideChat" | "compactThread" | "reviewThread" | "archiveThread" | "unarchiveThread" | "renameThread" | "deleteThread" | "installPlugin" | "uninstallPlugin" | "setPluginEnabled" | "addMarketplace" | "removeMarketplace" | "upgradeMarketplace" | "createWorktree" | "files" | "readFile" | "readImage" | "downloadFile" | "writeFile" | "createFile" | "createDirectory" | "renameProjectEntry" | "deleteProjectEntry" | "gitStatus" | "gitDiff" | "gitConflictStages" | "gitResolveConflictStage" | "gitStage" | "gitUnstage" | "gitCommit" | "gitCreateBranch" | "gitSwitchBranch" | "gitTrackRemoteBranch" | "gitFetch" | "gitPull" | "gitPush";
export interface MobileLocalJob { op:MobileLocalOperation; userId:number; args:Record<string,unknown>; }
const MOBILE_GLOBAL_OPERATIONS=new Set<MobileLocalOperation>(["listThreadReadStates","listThreadSections","createThreadSection","renameThreadSection","deleteThreadSection"]);
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
  private readonly mobileProjectCatalogues = new Map<number, {
    expiresAt: number;
    value: Promise<CodexProjectSummary[]>;
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
  private readonly historySearchCache = new Map<string, { size: number; mtimeMs: number; result: unknown }>();
  private readonly mobilePtys=new Map<string,MobilePtyRecord>();
  private readonly mobileMcpResources=new Map<string,MobileMcpResourceRef>();
  private readonly mobileEditableTurnCursors=new Map<string,MobileEditableTurnCursorRef>();
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
  stop():void{this.abort.abort();for(const terminal of this.mobilePtys.values())this.disposeMobilePty(terminal);this.mobilePtys.clear();this.mobileEditableTurnCursors.clear();}
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
      const known=this.knownThreads.get(userId)??new Map<string,CodexThreadSummary>();
      // Only side chats created by this owner in this live adapter are shown;
      // Codex's other ephemeral threads remain invisible.
      for(const t of known.values())if(t.ephemeral&&!visible.some(x=>x.id===t.id))visible.unshift(t);
      for(const t of this.ownThreads.values()){
        const owner=this.telegramSessions.getOwner(t.id)?.chatId;
        // A just-created app-server thread may be absent from thread/list until
        // its first turn is written. Keep the per-user entry created by the
        // authorized mobile/TMA action visible without exposing other users'
        // in-memory threads.
        if((owner===userId||known.has(t.id))&&!visible.some(x=>x.id===t.id))visible.unshift(t);
      }
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
  private async mobileProjectsFor(userId:number):Promise<CodexProjectSummary[]>{
    const cached=this.mobileProjectCatalogues.get(userId);
    if(cached&&cached.expiresAt>Date.now())return cached.value;
    const value=this.deps.acp.listProjects().catch(()=>[] as CodexProjectSummary[]);
    this.mobileProjectCatalogues.set(userId,{expiresAt:Date.now()+30_000,value});
    return value;
  }
  private async mobileProject(path:string,userId:number):Promise<{name:string;cwd:string}>{
    const projects=await this.mobileProjectsFor(userId);
    const matched=projects.find(project=>project.roots?.some(root=>(typeof root==="string"?root:root.path??root.root)===path));
    const known=[...(this.knownThreads.get(userId)?.values()??[]),...(this.archivedThreads.get(userId)?.values()??[])].some(thread=>thread.cwd===path);
    const allowed=this.deps.cfg.projectRoots.includes(path)||path===this.deps.cfg.workspace;
    if(!matched&&!known&&!allowed)throw new Error("Папка проекта не разрешена");
    return {name:matched?.name||basename(path),cwd:path};
  }
  private async mobileThreadPage(userId:number,options:{archived:boolean;cursor?:string;cwd?:string}):Promise<{threads:CodexThreadSummary[];nextCursor?:string}>{
    const {archived,cursor,cwd}=options;
    // Older TMA adapters and test doubles expose only listThreads/listAllThreads.
    // Keep those callers working; the real AcpClient uses the bounded native page.
    const page=typeof this.deps.acp.listThreadsPage==="function"
      ? await this.deps.acp.listThreadsPage({
        limit:100,sortKey:"recency_at",sortDirection:"desc",
        sourceKinds:["cli","vscode","appServer"],
        ...(archived?{archived:true}:{}),...(cursor?{cursor}:{}),...(cwd?{cwd}:{}),
      })
      : {threads:(archived?await this.archivedCatalogue(userId):(await this.catalogue(userId)).threads).slice(0,500)};
    const visible=page.threads.filter(thread=>{
      const owner=this.telegramSessions.getOwner(thread.id);
      return !thread.ephemeral&&(!owner||owner.chatId===userId)&&["cli","vscode","appServer"].includes(threadSourceKind(thread)??"");
    });
    const remembered=archived?this.archivedThreads.get(userId)??new Map<string,CodexThreadSummary>():this.knownThreads.get(userId)??new Map<string,CodexThreadSummary>();
    if(!cursor&&!archived){
      for(const thread of remembered.values()){
        if((!cwd||thread.cwd===cwd)&&!visible.some(current=>current.id===thread.id))visible.unshift(thread);
      }
      for(const thread of this.ownThreads.values()){
        const owner=this.telegramSessions.getOwner(thread.id)?.chatId;
        if((owner===userId||remembered.has(thread.id))&&(!cwd||thread.cwd===cwd)&&!visible.some(current=>current.id===thread.id))visible.unshift(thread);
      }
    }
    for(const thread of [...visible].reverse()){
      remembered.delete(thread.id);
      remembered.set(thread.id,thread);
      if(archived)this.knownThreads.get(userId)?.delete(thread.id);
      else this.archivedThreads.get(userId)?.delete(thread.id);
    }
    while(remembered.size>500){
      const oldest=remembered.keys().next().value;
      if(oldest===undefined)break;
      if(!archived&&oldest===this.selected.get(userId)){
        const selected=remembered.get(oldest);
        remembered.delete(oldest);
        if(selected)remembered.set(oldest,selected);
      }else remembered.delete(oldest);
    }
    if(archived)this.archivedThreads.set(userId,remembered);
    else this.knownThreads.set(userId,remembered);
    return {threads:visible,nextCursor:page.nextCursor};
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
    // Desktop may archive a selected session after the mobile catalogue was cached.
    // Re-read Codex's active and archived filters before authorizing a mutation.
    const known=this.knownThreads.get(userId)?.get(id)??this.archivedThreads.get(userId)?.get(id);
    const base={limit:100,sortKey:"recency_at" as const,sortDirection:"desc" as const,
      sourceKinds:["cli","vscode","appServer"] as Array<"cli"|"vscode"|"appServer">,
      ...(known?.cwd?{cwd:known.cwd}:{})};
    const contains=async(archived:boolean):Promise<boolean>=>{
      const params={...base,archived};
      if(typeof this.deps.acp.listThreadsPage==="function"){
        let cursor:string|undefined;
        const seenCursors=new Set<string>();
        for(let page=0;page<1000;page++){
          const result=await this.deps.acp.listThreadsPage({...params,...(cursor?{cursor}:{})});
          if(result.threads.some(thread=>thread.id===id))return true;
          const next=result.nextCursor;
          if(!next||next===cursor||seenCursors.has(next))return false;
          seenCursors.add(next);
          cursor=next;
        }
        return false;
      }
      const threads=typeof this.deps.acp.listAllThreads==="function"
        ?await this.deps.acp.listAllThreads(params)
        :await this.deps.acp.listThreads(params);
      return threads.some(thread=>thread.id===id);
    };
    if(await contains(false))return false;
    return contains(true);
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
    if(job.op!=="capabilities"&&job.op!=="searchThreads"&&job.op!=="listMoreThreads"&&!MOBILE_GLOBAL_OPERATIONS.has(job.op)&&!sessionId)throw new Error("Сначала выберите сеанс Codex");
    const runtime=sessionId?registry.runtimeForSession(chatId,sessionId):undefined;
    switch(job.op){
      case "listThreadReadStates":{
        const raw=args.sessionIds;
        if(!Array.isArray(raw)||raw.length>1000)throw new Error("Неверный список сеансов для проверки статуса прочтения");
        const states:Record<string,{firstUnread:{type:"threadStart"}|{type:"turn";turnId:string}|null;revision:string}>={};
        for(const id of new Set(raw.filter((value):value is string=>typeof value==="string"&&/^[a-z0-9_-]{8,128}$/i.test(value)))){
          try{
            const thread=await this.thread(id,chatId);
            if(!thread.ephemeral&&thread.readStateEligible&&thread.readState)states[id]=thread.readState;
          }catch{/* The mobile snapshot includes only already-authorized catalogue entries. */}
        }
        return {states};
      }
      case "updateThreadReadState":{
        const thread=await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.updateThreadReadState!=="function"||!thread.readStateEligible||!thread.readState)throw new Error("Codex не предоставляет управление статусом прочтения для этого сеанса");
        const expectedRevision=argumentString(args,"expectedRevision",512);
        const operation=args.operation;
        if(operation!=="read"&&operation!=="unread")throw new Error("Неизвестное действие со статусом прочтения");
        if(expectedRevision!==thread.readState.revision)throw new Error("Статус прочтения изменился. Обновите список сеансов и повторите действие.");
        let readState:CodexThreadReadState;
        try{readState=await acp.updateThreadReadState(sessionId,expectedRevision,operation);}
        catch(error){
          this.catalogues.delete(chatId);
          this.archivedCatalogues.delete(chatId);
          this.knownThreads.get(chatId)?.delete(sessionId);
          this.archivedThreads.get(chatId)?.delete(sessionId);
          throw error;
        }
        const updated={...thread,readStateMetadataAvailable:true,readStateEligible:true,readState};
        this.knownThreads.get(chatId)?.set(sessionId,updated);
        if(this.archivedThreads.get(chatId)?.has(sessionId))this.archivedThreads.get(chatId)?.set(sessionId,updated);
        if(this.ownThreads.has(sessionId))this.ownThreads.set(sessionId,updated);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,readState};
      }
      case "listThreadSections":{
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.listThreadSections!=="function")throw new Error("Эта версия Codex не поддерживает разделы сеансов");
        return await acp.listThreadSections();
      }
      case "createThreadSection":{
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.createThreadSection!=="function")throw new Error("Эта версия Codex не поддерживает разделы сеансов");
        const name=argumentString(args,"name",80).trim();
        if(!name||name.length>64||/[\u0000-\u001f\u007f]/.test(name))throw new Error("Название раздела должно содержать от 1 до 64 безопасных символов");
        return await acp.createThreadSection(name);
      }
      case "renameThreadSection":{
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.renameThreadSection!=="function"||typeof acp.listThreadSections!=="function")throw new Error("Эта версия Codex не поддерживает разделы сеансов");
        const sectionId=argumentString(args,"sectionId",80);
        if(sectionId===CODEX_PINNED_THREAD_SECTION_ID)throw new Error("Встроенный раздел закреплённых нельзя переименовать");
        const name=argumentString(args,"name",80).trim();
        if(!name||name.length>64||/[\u0000-\u001f\u007f]/.test(name))throw new Error("Название раздела должно содержать от 1 до 64 безопасных символов");
        if(!(await acp.listThreadSections()).some(section=>section.id===sectionId))throw new Error("Раздел не найден");
        return await acp.renameThreadSection(sectionId,name);
      }
      case "deleteThreadSection":{
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.deleteThreadSection!=="function"||typeof acp.listThreadSections!=="function")throw new Error("Эта версия Codex не поддерживает разделы сеансов");
        const sectionId=argumentString(args,"sectionId",80);
        if(sectionId===CODEX_PINNED_THREAD_SECTION_ID)throw new Error("Встроенный раздел закреплённых нельзя удалить");
        if(!(await acp.listThreadSections()).some(section=>section.id===sectionId))throw new Error("Раздел не найден");
        await acp.deleteThreadSection(sectionId);
        this.catalogues.clear();
        this.archivedCatalogues.clear();
        return {sectionId,deleted:true};
      }
      case "moveThreadToSection":{
        const thread=await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.moveThreadToSection!=="function"||typeof acp.listThreadSections!=="function")throw new Error("Эта версия Codex не поддерживает разделы сеансов");
        const sectionId=args.sectionId===null?null:argumentString(args,"sectionId",80);
        const sections=await acp.listThreadSections();
        const section=sectionId===null?undefined:sectionId===CODEX_PINNED_THREAD_SECTION_ID
          ? {id:CODEX_PINNED_THREAD_SECTION_ID,name:CODEX_PINNED_THREAD_SECTION_NAME}
          : sections.find(item=>item.id===sectionId);
        if(sectionId!==null&&!section)throw new Error("Раздел не найден");
        await acp.moveThreadToSection(sessionId,sectionId);
        const moved={...thread,section};
        this.knownThreads.get(chatId)?.set(sessionId,moved);
        if(this.archivedThreads.get(chatId)?.has(sessionId))this.archivedThreads.get(chatId)?.set(sessionId,moved);
        if(this.ownThreads.has(sessionId))this.ownThreads.set(sessionId,moved);
        this.catalogues.delete(chatId);
        this.archivedCatalogues.delete(chatId);
        return {sessionId,sectionId,pinned:sectionId===CODEX_PINNED_THREAD_SECTION_ID};
      }
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
          const status=normalizeThreadStatus(thread.status);
          return {
            id:thread.id,title:(thread.name||thread.preview||"Новый сеанс").slice(0,180),cwd:thread.cwd||"",
            updatedAt:thread.recencyAt||thread.updatedAt||thread.createdAt||0,
            source:threadSourceKind(thread)||"unknown",archived,busy:Boolean(current?.isBusy)||status?.status==="working"||status?.status==="approval",
            queue:current?.queueLength||0,liveStatus:status?.status??"unknown",liveLabel:status?.label??"Статус неизвестен",section:mobileThreadSection(thread.section),
          };
        });
        return {sessions,nextCursor:page.nextCursor};
      }
      case "listMoreThreads":{
        const archived=args.archived===true;
        // Keep older already-open web clients working during a rolling restart.
        if(args.cursor===undefined&&args.offset!==undefined){
          const offset=args.offset;
          if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0||offset>100_000)throw new Error("Неверное место продолжения списка сеансов");
          let legacyCwd:string|undefined;
          if(args.cwd!==undefined){
            if(typeof args.cwd!=="string"||args.cwd.length>700)throw new Error("Неверная папка проекта для списка сеансов");
            if(args.cwd.trim())legacyCwd=(await this.project(args.cwd.trim(),chatId)).cwd;
          }
          const legacyThreads=archived?await this.archivedCatalogue(chatId):(await this.catalogue(chatId)).threads;
          const legacyVisible=legacyThreads.filter(thread=>!legacyCwd||thread.cwd===legacyCwd);
          const legacyPage=legacyVisible.slice(offset,offset+100);
          const legacySessions=legacyPage.map(thread=>{
            const current=archived?undefined:registry.runtimeForSession(chatId,thread.id);
            const status=normalizeThreadStatus(thread.status);
            return {
              id:thread.id,title:(thread.name||thread.preview||(archived?"Без названия":"Новый сеанс")).slice(0,180),cwd:thread.cwd||"",
              updatedAt:thread.recencyAt||thread.updatedAt||thread.createdAt||0,
              source:threadSourceKind(thread)||"unknown",archived,busy:Boolean(current?.isBusy)||status?.status==="working"||status?.status==="approval",
              queue:current?.queueLength||0,liveStatus:status?.status??"unknown",liveLabel:status?.label??"Статус неизвестен",section:mobileThreadSection(thread.section),
            };
          });
          const nextOffset=offset+legacyPage.length;
          return {sessions:legacySessions,...(nextOffset<legacyVisible.length?{nextOffset}:{})};
        }
        const cursor=args.cursor===undefined?undefined:argumentString(args,"cursor",2048);
        let cwd:string|undefined;
        if(args.cwd!==undefined){
          if(typeof args.cwd!=="string"||args.cwd.length>700)throw new Error("Неверная папка проекта для списка сеансов");
          if(args.cwd.trim())cwd=(await this.mobileProject(args.cwd.trim(),chatId)).cwd;
        }
        const page=await this.mobileThreadPage(chatId,{archived,cursor,cwd});
        const sessions=page.threads.map(thread=>{
          const current=archived?undefined:registry.runtimeForSession(chatId,thread.id);
          const status=normalizeThreadStatus(thread.status);
          return {
            id:thread.id,title:(thread.name||thread.preview||(archived?"Без названия":"Новый сеанс")).slice(0,180),cwd:thread.cwd||"",
            updatedAt:thread.recencyAt||thread.updatedAt||thread.createdAt||0,
            source:threadSourceKind(thread)||"unknown",archived,busy:Boolean(current?.isBusy)||status?.status==="working"||status?.status==="approval",
            queue:current?.queueLength||0,liveStatus:status?.status??"unknown",liveLabel:status?.label??"Статус неизвестен",section:mobileThreadSection(thread.section),
          };
        });
        return {sessions,...(page.nextCursor?{nextCursor:page.nextCursor}:{})};
      }
      case "searchHistory":{
        await this.thread(sessionId,chatId);
        const query=argumentString(args,"query",100).trim();
        if(query.length<2)throw new Error("Поисковый запрос должен содержать не меньше двух символов");
        const includeTools=args.includeTools===true;
        const beforeOffset=args.beforeOffset;
        const requestedRevision=args.revision;
        if((beforeOffset===undefined)!==(requestedRevision===undefined))throw new Error("Неверная страница поиска по истории");
        if(beforeOffset!==undefined&&(!Number.isSafeInteger(beforeOffset)||Number(beforeOffset)<0))throw new Error("Неверная страница поиска по истории");
        if(requestedRevision!==undefined&&(typeof requestedRevision!=="string"||!/^[a-f0-9]{16}$/.test(requestedRevision)))throw new Error("Неверная страница поиска по истории");
        const path=this.store.jsonlPath(sessionId);
        const stat=statSyncSafe(path);
        const revision=createHash("sha256").update(JSON.stringify([sessionId,query.toLowerCase(),includeTools,stat.size,stat.mtimeMs])).digest("hex").slice(0,16);
        if(requestedRevision!==undefined&&requestedRevision!==revision)throw new Error("История Codex изменилась. Повторите поиск.");
        const cacheKey=chatId+":"+sessionId+":"+(includeTools?"tools":"chat")+":"+query.toLowerCase()+":"+revision+":"+(beforeOffset??"latest");
        const cached=this.historySearchCache.get(cacheKey);
        if(cached&&cached.size===stat.size&&cached.mtimeMs===stat.mtimeMs)return cached.result;
        const result=await searchConversationHistoryAsync(path,query,includeTools,100,beforeOffset as number|undefined);
        const after=statSyncSafe(path);
        if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw new Error("История Codex изменилась. Повторите поиск.");
        const response={...result,revision};
        this.historySearchCache.set(cacheKey,{...stat,result:response});
        if(this.historySearchCache.size>10)this.historySearchCache.delete(this.historySearchCache.keys().next().value!);
        return response;
      }
      case "latestEditableTurn":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.readMobileLatestEditableTurn!=="function")throw new Error("Эта версия Codex не поддерживает редактирование последнего запроса");
        const turn=await acp.readMobileLatestEditableTurn(sessionId);
        return turn?mobileEditableTurnSummary(turn):{editable:false,reason:"Последний запрос Codex не найден"};
      }
      case "listEditableTurns":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.readMobileEditableTurnsPage!=="function")throw new Error("Эта версия Codex не поддерживает просмотр запросов для редактирования");
        const cursorRef=args.cursor===undefined?undefined:argumentString(args,"cursor",36);
        const stored=cursorRef?this.mobileEditableTurnCursors.get(cursorRef):undefined;
        if(cursorRef&&(!/^[a-f0-9-]{36}$/i.test(cursorRef)||!stored||stored.expiresAt<=Date.now()||stored.ownerId!==chatId||stored.sessionId!==sessionId)){
          if(stored&&stored.expiresAt<=Date.now())this.mobileEditableTurnCursors.delete(cursorRef);
          throw new Error("Страница запросов устарела. Обновите список перед продолжением");
        }
        const first=stored?await acp.readMobileEditableTurnsPage(sessionId):undefined;
        if(stored&&first?.latestTurnId!==stored.latestTurnId){
          this.mobileEditableTurnCursors.delete(cursorRef!);
          throw new Error("История Codex изменилась. Обновите список запросов перед продолжением");
        }
        const page=stored?await acp.readMobileEditableTurnsPage(sessionId,stored.cursor):await acp.readMobileEditableTurnsPage(sessionId);
        const latestTurnId=stored?.latestTurnId??page.latestTurnId;
        const nextCursor=page.nextCursor&&latestTurnId?this.issueMobileEditableTurnCursor(chatId,sessionId,page.nextCursor,latestTurnId):undefined;
        return {latestTurnId,turns:page.turns.map(mobileEditableTurnSummary),...(nextCursor?{nextCursor}:{})};
      }
      case "editAndRetry":{
        const turnId=argumentString(args,"turnId",128);
        const expectedLatestTurnId=argumentString(args,"expectedLatestTurnId",128);
        const message=argumentString(args,"text",16000).trim();
        if(!message)throw new Error("Введите текст запроса для повтора");
        if(!expectedLatestTurnId)throw new Error("Обновите список запросов перед редактированием");
        const requestId=argumentString(args,"requestId",80);
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор запроса");
        const fingerprint=tmaPromptFingerprint("edit-and-retry:"+turnId+":"+expectedLatestTurnId+":"+message,[]);
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
            if(typeof acp.revertMobileThread!=="function")throw new Error("Эта версия Codex не поддерживает редактирование запросов");
            const controller=registry.controller(chatId);
            if(controller.foreground().sessionId!==sessionId)await controller.switchTo(sessionId);
            const current=registry.runtimeForSession(chatId,sessionId);
            if(!current||current.isBusy||current.queueLength>0||(typeof acp.hasActiveTurn==="function"&&acp.hasActiveTurn(sessionId)))throw new Error("Сеанс изменил состояние. Обновите его перед редактированием");
            this.promptJournal.reserve(key,fingerprint);
            reserved=true;
            const selected=await acp.revertMobileThread!(sessionId,turnId,expectedLatestTurnId,undefined,()=>{dispatched=true;});
            this.historyCache.delete(sessionId+":chat");
            this.historyCache.delete(sessionId+":tools");
            const input=textPrompt(message);
            input.skillNames=selected.skillNames;
            input.appIds=selected.appIds??[];
            input.images=selected.resendImages??[];
            input.localImages=selected.resendLocalImages??[];
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
      case "listRealtimeVoices":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.listRealtimeVoices!=="function")throw new Error("Эта версия Codex не поддерживает выбор голоса");
        return await acp.listRealtimeVoices();
      }
      case "startRealtime":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        const current=registry.runtimeForSession(chatId,sessionId);
        if(!current)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        if(current.isBusy||current.queueLength>0||(typeof acp.hasActiveTurn==="function"&&acp.hasActiveTurn(sessionId)))
          throw new Error("Дождитесь завершения текущей задачи и очереди перед запуском голосового режима");
        if(typeof acp.startRealtime!=="function")throw new Error("Эта версия Codex не поддерживает голосовой режим");
        const sdp=argumentString(args,"sdp",128_000);
        if(!/^v=0\r?$/m.test(sdp)||!/^m=audio\s/m.test(sdp)||!/^m=application\s/m.test(sdp))
          throw new Error("Браузер не сформировал корректное аудиосоединение");
        const voice=args.voice===undefined?undefined:argumentString(args,"voice",32);
        if(voice!==undefined){
          if(typeof acp.listRealtimeVoices!=="function")throw new Error("Эта версия Codex не поддерживает выбор голоса");
          const available=await acp.listRealtimeVoices();
          if(!available.voices.includes(voice))throw new Error("Выбранный голос Codex сейчас недоступен");
        }
        return {sdp:await acp.startRealtime(sessionId,sdp,voice)};
      }
      case "stopRealtime":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof acp.stopRealtime!=="function")throw new Error("Эта версия Codex не поддерживает голосовой режим");
        await acp.stopRealtime(sessionId);
        return {stopped:true};
      }
      case "terminalExec":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя запускать команду в архивном сеансе");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        const command=argumentString(args,"command",4000).trim();
        if(!command||command.includes("\0"))throw new Error("Введите корректную команду");
        return runMobileTerminalCommand(root,command);
      }
      case "listTerminalShells":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return {shells:mobileTerminalShells().map(({id,label})=>({id,label}))};
      }
      case "terminalStart":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя запускать терминал в архивном сеансе");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        return this.startMobilePty(chatId,sessionId,root,args.shell);
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
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(!thread.cwd)throw new Error("Неизвестная рабочая папка сеанса");
        if(typeof acp.listMobileBackgroundTerminals!=="function")throw new Error("Эта версия Codex не поддерживает список фоновых процессов");
        const controller=registry.controller(chatId);
        if(controller.runtimeForSession(sessionId))await controller.switchTo(sessionId);
        else await controller.addAttach(sessionId,thread.cwd,basename(thread.cwd),[]);
        this.selected.set(chatId,sessionId);
        return {items:await acp.listMobileBackgroundTerminals(sessionId)};
      }
      case "stopBackgroundTerminal":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const thread=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Сначала восстановите сеанс из архива");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(!thread.cwd)throw new Error("Неизвестная рабочая папка сеанса");
        if(typeof acp.terminateMobileBackgroundTerminal!=="function")throw new Error("Эта версия Codex не поддерживает остановку фоновых процессов");
        const controller=registry.controller(chatId);
        if(controller.runtimeForSession(sessionId))await controller.switchTo(sessionId);
        else await controller.addAttach(sessionId,thread.cwd,basename(thread.cwd),[]);
        this.selected.set(chatId,sessionId);
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
      case "createSideChat":{
        const source=await this.thread(sessionId,chatId);
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя открыть side chat из архивного сеанса");
        if(!source.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(!acp.isConnected||typeof acp.forkThread!=="function")throw new Error("Текущая версия Codex не поддерживает side chat");
        // Codex Desktop side chats are ephemeral forks. Excluding the parent's
        // current turns lets a phone ask a side question without stopping the
        // main task or creating a persistent second session.
        const fork=await acp.forkThread(sessionId,{ephemeral:true,excludeTurns:true});
        const forkId=fork.thread.id;
        if(!/^[a-z0-9_-]{8,128}$/i.test(forkId)||forkId===sessionId)throw new Error("Codex вернул недопустимый ID side chat");
        if(fork.thread.ephemeral!==true){
          try{await acp.archiveThread(forkId);await acp.deleteThread(forkId);}catch{/* best-effort cleanup of an unsupported persistent fork */}
          throw new Error("Эта версия Codex не подтвердила временный side chat; создание отменено");
        }
        const sourceRoot=realpathSync.native(source.cwd);
        const forkRoot=realpathSync.native(fork.cwd||source.cwd);
        if(resolve(sourceRoot).toLowerCase()!==resolve(forkRoot).toLowerCase())throw new Error("Codex открыл side chat в другой папке проекта");
        const now=Date.now()/1000;
        const child:CodexThreadSummary={
          ...fork.thread,
          id:forkId,
          name:typeof fork.thread.name==="string"&&fork.thread.name.trim()?fork.thread.name:`${source.name||"Сеанс"} · side chat`,
          cwd:source.cwd,
          source:fork.thread.source||"appServer",
          createdAt:typeof fork.thread.createdAt==="number"?fork.thread.createdAt:now,
          updatedAt:typeof fork.thread.updatedAt==="number"?fork.thread.updatedAt:now,
          recencyAt:typeof fork.thread.recencyAt==="number"?fork.thread.recencyAt:now,
          parentThreadId:sessionId,
          ephemeral:true,
        };
        const known=this.knownThreads.get(chatId)??new Map<string,CodexThreadSummary>();
        known.set(forkId,child);
        this.knownThreads.set(chatId,known);
        this.catalogues.delete(chatId);
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
        const appIds=selectedMobileAppIds(args.appIds);
        if(!text&&!images.length)throw new Error("Напишите направление для Codex или прикрепите фото");
        const requestId=argumentString(args,"requestId",80);
        if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор направления");
        const fingerprint=tmaPromptFingerprint("steer:"+text,images,appIds.map(id=>"app:"+id));
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
            if(appIds.length)input.appIds=appIds;
            const skillNames=await mobileSkillsRequestedByPrompt(acp,text,thread.cwd);
            const selectedSkills=skillNames.filter(name=>!appIds.includes(name));
            if(selectedSkills.length)input.skillNames=selectedSkills;
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
        const section=args.section;
        if(section!==undefined&&section!=="core"&&section!=="skills"&&section!=="apps"&&section!=="plugins"&&section!=="mcp")throw new Error("Неизвестный раздел возможностей Codex");
        if(section&&!sessionId)throw new Error("Для этого списка выберите сеанс Codex");
        if(sessionId&&!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const integrationThread=sessionId?await this.thread(sessionId,chatId).catch(()=>undefined):undefined;
        if(section==="core"){
          const emptyAccount:Awaited<ReturnType<typeof acp.accountState>>={};
          const [nativeSettings,goalState,account]=await Promise.all([
            integrationThread&&acp.isConnected&&typeof acp.readMobileThreadSettings==="function"
              ? acp.readMobileThreadSettings(sessionId).catch(()=>undefined)
              : Promise.resolve(undefined),
            acp.isConnected&&typeof acp.getThreadGoal==="function"?acp.getThreadGoal(sessionId).then(goal=>({goal,available:true})).catch(()=>({goal:undefined,available:false}))
              : Promise.resolve({goal:undefined,available:false}),
            acp.isConnected?acp.accountState().catch(()=>emptyAccount):Promise.resolve(emptyAccount),
          ]);
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
          const {goal,available:goalAvailable}=goalState;
          return {
            capabilitySection:"core",
            online:acp.isConnected,
            model:nativeSettings&&"model" in nativeSettings?(nativeSettings.model||"default"):runtime?.model||acp.currentModelId||"default",
            mode:runtime?.agent||acp.currentModeId||"",
            reasoning:nativeSettings&&"effort" in nativeSettings?(nativeSettings.effort||runtime?.reasoning||"medium"):runtime?.reasoning||"medium",
            models:acp.availableModels.slice(0,100).map(m=>({id:m.modelId.slice(0,160),name:m.name.slice(0,160),description:m.description?.slice(0,400)})),
            modes:acp.availableModes.slice(0,60).map(m=>({id:m.id.slice(0,100),name:m.name.slice(0,120),description:m.description?.slice(0,300)})),
            reasoningLevels:REASONING_LEVELS,skills:[],mcpServersAvailable:false,mcpServers:[],plugins:[],pluginCatalogAvailable:false,
            marketplaces:[],apps:[],appsAvailable:false,account:account.account?{type:account.account.type,email:account.account.email?.slice(0,200),
              plan:account.account.planType?.slice(0,100)}:undefined,limits,subagents,checkedAt:Date.now(),goal,goalAvailable,
          };
        }
        if(section==="skills"){
          const skills=integrationThread?.cwd&&acp.isConnected&&typeof acp.listMobileSkills==="function"
            ? await acp.listMobileSkills(integrationThread.cwd).catch(()=>acp.availableSkills)
            : acp.availableSkills;
          const skillNameCounts=new Map<string,number>();
          for(const skill of skills)skillNameCounts.set(skill.name,(skillNameCounts.get(skill.name)??0)+1);
          return {capabilitySection:"skills",skills:skills.slice(0,100).map(skill=>({name:skill.name.slice(0,160),description:skill.description?.slice(0,500),
            enabled:skill.enabled!==false,scope:skill.scope,canToggle:(skill.scope==="user"||skill.scope==="repo")&&skillNameCounts.get(skill.name)===1,
            invokable:skill.enabled!==false&&skillNameCounts.get(skill.name)===1}))};
        }
        if(section==="apps"){
          const rawApps=acp.isConnected&&integrationThread&&typeof acp.mobileAppInventory==="function"
            ? await acp.mobileAppInventory(sessionId)
            : acp.isConnected&&integrationThread&&typeof acp.mobileIntegrationInventory==="function"
              ? await acp.mobileIntegrationInventory(integrationThread.cwd,sessionId)
              : undefined;
          const integrations=normalizeMobileIntegrations(undefined,undefined,rawApps?.apps,rawApps?.installedApps);
          return {capabilitySection:"apps",apps:integrations.apps,appsAvailable:integrations.appsAvailable};
        }
        if(section==="plugins"){
          const rawPlugins=acp.isConnected&&integrationThread&&typeof acp.mobilePluginInventory==="function"
            ? await acp.mobilePluginInventory(integrationThread.cwd).catch(()=>undefined)
            : undefined;
          const integrations=normalizeMobileIntegrations(rawPlugins?.pluginCatalog,rawPlugins?.installedPlugins,undefined,undefined);
          return {
            capabilitySection:"plugins",
            plugins:integrations.plugins,
            pluginCatalogAvailable:integrations.pluginCatalogAvailable,
            marketplaces:normalizeMobileMarketplaces(rawPlugins?.pluginCatalog,rawPlugins?.installedPlugins),
          };
        }
        if(section==="mcp"){
          if(!acp.isConnected||!integrationThread||typeof acp.listMobileMcpServers!=="function")return {capabilitySection:"mcp",mcpServersAvailable:false,mcpServers:[]};
          try{
            const mcpInventory=await acp.listMobileMcpServers(sessionId);
            const resourceRefs=this.issueMobileMcpResourceRefs(chatId,sessionId,mcpInventory);
            return {capabilitySection:"mcp",mcpServersAvailable:true,mcpServers:normalizeMobileMcpServers(mcpInventory).map(server=>({
              ...server,resources:resourceRefs.get(server.name)??[],
            }))};
          }catch{return {capabilitySection:"mcp",mcpServersAvailable:false,mcpServers:[]};}
        }
        const inventoryRefresh=acp.isConnected?acp.refreshInventories().catch(()=>undefined):Promise.resolve(undefined);
        const nativeSettingsRead=sessionId&&integrationThread&&acp.isConnected&&typeof acp.readMobileThreadSettings==="function"
          ? acp.readMobileThreadSettings(sessionId).catch(()=>undefined)
          : Promise.resolve(undefined);
        const integrationRead=acp.isConnected&&typeof acp.mobileIntegrationInventory==="function"
          ? acp.mobileIntegrationInventory(integrationThread?.cwd,sessionId||undefined).catch(()=>undefined)
          : Promise.resolve(undefined);
        const mcpRead=acp.isConnected&&integrationThread&&typeof acp.listMobileMcpServers==="function"
          ? acp.listMobileMcpServers(sessionId).then(inventory=>({inventory,available:true})).catch(()=>({inventory:[],available:false}))
          : Promise.resolve({inventory:acp.availableMcpServers,available:acp.isConnected});
        const skillsRead=integrationThread?.cwd&&acp.isConnected&&typeof acp.listMobileSkills==="function"
          ? acp.listMobileSkills(integrationThread.cwd).catch(()=>acp.availableSkills)
          : Promise.resolve(acp.availableSkills);
        const goalRead=sessionId&&acp.isConnected&&typeof acp.getThreadGoal==="function"
          ? acp.getThreadGoal(sessionId).then(goal=>({goal,available:true})).catch(()=>({goal:undefined,available:false}))
          : Promise.resolve({goal:undefined,available:false});
        const emptyAccount:Awaited<ReturnType<typeof acp.accountState>>={};
        const accountRead=acp.isConnected?acp.accountState().catch(()=>emptyAccount):Promise.resolve(emptyAccount);
        const [,nativeSettings,rawIntegrations,mcpState,skills,goalState,account]=await Promise.all([
          inventoryRefresh,nativeSettingsRead,integrationRead,mcpRead,skillsRead,goalRead,accountRead,
        ]);
        const {inventory:mcpInventory,available:mcpServersAvailable}=mcpState;
        const skillNameCounts=new Map<string,number>();
        for(const skill of skills)skillNameCounts.set(skill.name,(skillNameCounts.get(skill.name)??0)+1);
        const integrations=normalizeMobileIntegrations(rawIntegrations?.pluginCatalog,rawIntegrations?.installedPlugins,
          rawIntegrations?.apps,rawIntegrations?.installedApps);
        const resourceRefs=this.issueMobileMcpResourceRefs(chatId,sessionId,
          acp.isConnected&&integrationThread&&mcpServersAvailable?mcpInventory:[]);
        const {goal,available:goalAvailable}=goalState;
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
          capabilitySection:"all",
          online:acp.isConnected,
          model:nativeSettings&&"model" in nativeSettings?(nativeSettings.model||"default"):runtime?.model||acp.currentModelId||"default",
          mode:runtime?.agent||acp.currentModeId||"",
          reasoning:nativeSettings&&"effort" in nativeSettings?(nativeSettings.effort||runtime?.reasoning||"medium"):runtime?.reasoning||"medium",
          models:acp.availableModels.slice(0,100).map(m=>({id:m.modelId.slice(0,160),name:m.name.slice(0,160),description:m.description?.slice(0,400)})),
          modes:acp.availableModes.slice(0,60).map(m=>({id:m.id.slice(0,100),name:m.name.slice(0,120),description:m.description?.slice(0,300)})),
          reasoningLevels:REASONING_LEVELS,
          skills:skills.slice(0,100).map(s=>({name:s.name.slice(0,160),description:s.description?.slice(0,500),
            enabled:s.enabled!==false,scope:s.scope,canToggle:(s.scope==="user"||s.scope==="repo")&&skillNameCounts.get(s.name)===1,
            invokable:s.enabled!==false&&skillNameCounts.get(s.name)===1})),
          mcpServersAvailable,mcpServers:normalizeMobileMcpServers(mcpInventory).map(server=>({
            ...server,resources:resourceRefs.get(server.name)??[],
          })),
          plugins:integrations.plugins,pluginCatalogAvailable:integrations.pluginCatalogAvailable,
          marketplaces:normalizeMobileMarketplaces(rawIntegrations?.pluginCatalog,rawIntegrations?.installedPlugins),
          apps:integrations.apps,appsAvailable:integrations.appsAvailable,
          account:account.account?{type:account.account.type,email:account.account.email?.slice(0,200),plan:account.account.planType?.slice(0,100)}:undefined,
          limits,subagents,checkedAt:Date.now(),
          goal,goalAvailable,
        };
      }
      case "listOlderScreenshots":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const sources=await this.mobileScreenshotSources(sessionId,chatId);
        let cursor:MobileScreenshotCursor={sourceIndex:0};
        if(args.cursor!==undefined){
          if(typeof args.cursor!=="string")throw new Error("Некорректный указатель страницы скриншотов");
          cursor=decodeMobileScreenshotCursor(args.cursor,sessionId);
        }else if(args.beforeOffset!==undefined){
          if(!Number.isSafeInteger(args.beforeOffset)|| (args.beforeOffset as number)<0)throw new Error("Некорректный указатель страницы скриншотов");
          cursor.beforeOffset=args.beforeOffset as number;
        }
        if(cursor.sourceIndex>=sources.length)throw new Error("Некорректный указатель страницы скриншотов");
        const source=sources[cursor.sourceIndex]!;
        const page=await this.screenshots.olderPage(source.threadId,source.path,source.cwd,cursor.beforeOffset,true,source.endByteOffset);
        const next=page.nextCursor!==undefined
          ?{sourceIndex:cursor.sourceIndex,beforeOffset:page.nextCursor}
          :cursor.sourceIndex+1<sources.length?{sourceIndex:cursor.sourceIndex+1}:undefined;
        return {images:page.images,...(next?{nextCursor:encodeMobileScreenshotCursor(sessionId,next)}:{})};
      }
      case "listMcpConfig":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const selected=await this.thread(sessionId,chatId);
        return listMobileMcpConfig(selected.cwd||"");
      }
      case "setMcpConfigEnabled":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять настройки MCP из архивного сеанса");
        const selected=await this.thread(sessionId,chatId);
        if(typeof args.enabled!=="boolean")throw new Error("Состояние MCP-сервера должно быть включено или выключено");
        const scope=args.scope;
        if(scope!==undefined&&scope!=="global"&&scope!=="workspace")throw new Error("Выберите область MCP-сервера");
        return setMobileMcpConfigEnabled(selected.cwd||"",argumentString(args,"name",128),args.enabled,scope);
      }
      case "removeMcpConfigServer":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять настройки MCP из архивного сеанса");
        const selected=await this.thread(sessionId,chatId);
        if(!selected.cwd)throw new Error("Для этого сеанса Codex не найден проект");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(acp.hasInflightPrompt()||registry.hasPendingWork())throw new Error("Дождитесь завершения всех задач Codex перед удалением MCP-сервера");
        const scope=args.scope;
        if(scope!=="global"&&scope!=="workspace")throw new Error("Выберите область MCP-сервера");
        return removeMobileMcpConfigServer(selected.cwd,argumentString(args,"name",128),scope);
      }
      case "addMcpConfigServer":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять настройки MCP из архивного сеанса");
        const selected=await this.thread(sessionId,chatId);
        if(!selected.cwd)throw new Error("Для этого сеанса Codex не найден проект");
        return addMobileMcpConfigServer(selected.cwd,args);
      }
      case "restartCodex":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        await this.thread(sessionId,chatId);
        return restartMobileCodex(acp,registry);
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
      case "callMcpTool":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя вызывать MCP-инструмент из архивного сеанса");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(acp.hasInflightPrompt()||registry.hasPendingWork())throw new Error("Дождитесь завершения всех задач Codex и очистите очередь перед вызовом MCP-инструмента");
        if(typeof acp.callMobileMcpTool!=="function")throw new Error("Эта версия Codex не поддерживает прямые вызовы MCP-инструментов");
        const server=argumentString(args,"server",120);
        const tool=argumentString(args,"tool",120);
        const argumentsValue=args.arguments===undefined?{}:args.arguments;
        if(!argumentsValue||typeof argumentsValue!=="object"||Array.isArray(argumentsValue))throw new Error("Аргументы MCP-инструмента должны быть JSON-объектом");
        return await acp.callMobileMcpTool(sessionId,server,tool,argumentsValue);
      }
      case "readMcpResource":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя читать MCP-ресурс из архивного сеанса");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(acp.hasInflightPrompt()||registry.hasPendingWork())throw new Error("Дождитесь завершения всех задач Codex и очистите очередь перед чтением MCP-ресурса");
        if(typeof acp.readMobileMcpResource!=="function")throw new Error("Эта версия Codex не поддерживает чтение MCP-ресурсов");
        const resourceId=argumentString(args,"resourceId",64);
        const resource=this.mobileMcpResources.get(resourceId);
        if(!resource||resource.expiresAt<Date.now()||resource.ownerId!==chatId||resource.sessionId!==sessionId){
          this.mobileMcpResources.delete(resourceId);
          throw new Error("Ссылка на MCP-ресурс устарела. Обновите настройки Codex.");
        }
        const uri=resource.uriTemplate
          ?resolveMobileMcpResourceTemplate(resource.uriTemplate,args.parameters)
          :resource.uri;
        if(!uri)throw new Error("Ссылка на MCP-ресурс устарела. Обновите настройки Codex.");
        return await acp.readMobileMcpResource(sessionId,resource.serverName,uri,resource.uriTemplate);
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
      case "setPluginEnabled":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять плагины из архивного сеанса");
        const thread=await this.thread(sessionId,chatId);
        if(!thread.cwd)throw new Error("Для сеанса не определена папка проекта");
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        if(typeof args.enabled!=="boolean")throw new Error("Укажите новое состояние плагина");
        const pluginId=argumentString(args,"pluginId",200);
        if(!pluginId)throw new Error("Выберите установленный плагин Codex");
        if(typeof acp.setMobilePluginEnabled!=="function")throw new Error("Эта версия Codex не поддерживает включение плагинов");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(acp.hasInflightPrompt()||registry.hasPendingWork())throw new Error("Дождитесь завершения всех задач Codex и очистите очередь перед изменением глобальной настройки плагина");
        const effectiveEnabled=await acp.setMobilePluginEnabled(pluginId,args.enabled,thread.cwd);
        return {pluginId,enabled:effectiveEnabled};
      }
      case "addMarketplace":
      case "removeMarketplace":
      case "upgradeMarketplace":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(await this.isArchivedThread(sessionId,chatId))throw new Error("Нельзя менять каталоги Codex из архивного сеанса");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        this.requireIdleMobileRuntime(sessionId,chatId);
        if(acp.hasInflightPrompt()||registry.hasPendingWork())throw new Error("Дождитесь завершения всех задач Codex перед изменением глобального каталога");
        if(job.op==="addMarketplace"){
          const source=argumentString(args,"source",2048);
          const rawRef=args.refName;
          if(rawRef!==undefined&&typeof rawRef!=="string")throw new Error("Неверная ветка или версия каталога");
          if(typeof acp.addMobileMarketplace!=="function")throw new Error("Эта версия Codex не поддерживает каталоги плагинов");
          return await acp.addMobileMarketplace(source,typeof rawRef==="string"?rawRef:undefined);
        }
        const marketplaceName=argumentString(args,"marketplaceName",120);
        if(job.op==="removeMarketplace"){
          if(typeof acp.removeMobileMarketplace!=="function")throw new Error("Эта версия Codex не поддерживает удаление каталогов");
          await acp.removeMobileMarketplace(marketplaceName);
          return {marketplaceName,removed:true};
        }
        if(typeof acp.upgradeMobileMarketplace!=="function")throw new Error("Эта версия Codex не поддерживает обновление каталогов");
        await acp.upgradeMobileMarketplace(marketplaceName);
        return {marketplaceName,upgraded:true};
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
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        const model=argumentString(args,"modelId",160);
        if(model!=="default"&&!acp.hasModel(model))throw new Error("Эта модель сейчас недоступна");
        if(typeof acp.updateMobileThreadSettings!=="function")throw new Error("Эта версия Codex не поддерживает сохранение настроек сеанса");
        await acp.updateMobileThreadSettings(sessionId,{modelId:model==="default"?null:model});
        const result=await runtime.setModelPref(model==="default"?"":model);
        if(!result.ok)throw new Error(result.error||"Не удалось сменить модель");
        return {model:model==="default"?"default":model};
      }
      case "setMode":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        const mode=argumentString(args,"modeId",100);
        if(mode!=="default"&&!acp.hasMode(mode))throw new Error("Этот режим сейчас недоступен");
        if(typeof acp.updateMobileThreadSettings!=="function")throw new Error("Эта версия Codex не поддерживает сохранение настроек сеанса");
        await acp.updateMobileThreadSettings(sessionId,{modeId:mode==="default"?null:mode});
        const result=await runtime.setAgentPref(mode==="default"?"":mode);
        if(!result.ok)throw new Error(result.error||"Не удалось сменить режим");
        return {mode:mode==="default"?"":mode};
      }
      case "setReasoning":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
        await this.thread(sessionId,chatId);
        if(!acp.isConnected)throw new Error("Codex сейчас офлайн");
        const effort=argumentString(args,"effort",20);
        if(!REASONING_LEVELS.includes(effort as ReasoningEffort))throw new Error("Недопустимый уровень рассуждений");
        if(typeof acp.updateMobileThreadSettings!=="function")throw new Error("Эта версия Codex не поддерживает сохранение настроек сеанса");
        await acp.updateMobileThreadSettings(sessionId,{effort});
        runtime.setReasoningPref(effort as ReasoningEffort);
        return {reasoning:effort};
      }
      case "files":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const offset=args.offset===undefined?0:args.offset;
        if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0||offset>100_000_000)throw new Error("Недопустимое смещение списка файлов");
        return this.mobileFileList(sessionId,chatId,typeof args.path==="string"?args.path:"",offset);
      }
      case "readFile":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileReadFile(sessionId,chatId,argumentString(args,"path",1200));
      }
      case "readImage":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileReadImage(sessionId,chatId,argumentString(args,"path",1200));
      }
      case "downloadFile":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileDownloadFile(sessionId,chatId,argumentString(args,"path",1200));
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
      case "createDirectory":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        const rawPath=argumentString(args,"path",1200);
        if(!rawPath||isAbsolute(rawPath)||/^[a-z]:/i.test(rawPath)||rawPath.startsWith("\\\\"))throw new Error("Ожидался относительный путь внутри проекта");
        const parts=rawPath.split(/[\\/]+/).filter(Boolean);
        if(parts.some(part=>part===".."||part==="."||part.includes(":")||part.includes("\0")))throw new Error("Недопустимый путь внутри проекта");
        if(parts.some(part=>this.isHiddenMobileFile(part)))throw new Error("Этот каталог недоступен в мобильном просмотре");
        const name=parts.pop();
        if(!name||this.isHiddenMobileFile(name))throw new Error("Этот каталог недоступен в мобильном просмотре");
        const {root}=this.mobileRoot(sessionId,chatId);
        const parent=parts.length?this.mobilePath(root,parts.join("/")):root;
        if(!statSync(parent).isDirectory())throw new Error("Папка для нового каталога не найдена");
        const actualParent=realpathSync.native(parent);
        if(!isPathWithinRoot(root,actualParent))throw new Error("Путь выходит за пределы проекта");
        const absolute=resolve(actualParent,name);
        if(!isPathWithinRoot(root,absolute))throw new Error("Путь выходит за пределы проекта");
        try{lstatSync(absolute);throw new Error("Каталог уже существует");}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        this.requireIdleMobileRuntime(sessionId,chatId);
        try{mkdirSync(absolute);}
        catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("Каталог уже существует");throw error;}
        return {path:relative(root,absolute).split(sep).join("/")};
      }
      case "renameProjectEntry":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        const entry=this.mobileProjectEntry(root,argumentString(args,"path",1200));
        this.assertMobileEntrySnapshot(entry,args);
        const newName=this.mobileEntryName(argumentString(args,"newName",255));
        if(newName===entry.name)throw new Error("Новое имя совпадает с текущим");
        const target=resolve(entry.parent,newName);
        if(!isPathWithinRoot(root,target))throw new Error("Новое имя выходит за пределы проекта");
        try{lstatSync(target);throw new Error("В этой папке уже есть такой файл или каталог");}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        const latest=this.mobileProjectEntry(root,entry.path);
        this.assertMobileEntrySnapshot(latest,args);
        if(realpathSync.native(latest.parent)!==entry.parent||!isPathWithinRoot(root,entry.parent))throw new Error("Папка изменилась. Обновите список файлов.");
        try{lstatSync(target);throw new Error("В этой папке уже есть такой файл или каталог");}
        catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        renameSync(latest.absolute,target);
        return {from:entry.path,path:relative(root,target).split(sep).join("/"),kind:entry.kind};
      }
      case "deleteProjectEntry":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root}=this.mobileRoot(sessionId,chatId);
        const entry=this.mobileProjectEntry(root,argumentString(args,"path",1200));
        this.assertMobileEntrySnapshot(entry,args);
        const latest=this.mobileProjectEntry(root,entry.path);
        this.assertMobileEntrySnapshot(latest,args);
        try{
          if(entry.kind==="directory"){
            if(argumentString(args,"confirmationName",255)!==entry.name)throw new Error("Введите точное имя папки, чтобы подтвердить удаление");
            this.removeMobileEntryTree(root,latest.absolute);
          }else unlinkSync(latest.absolute);
        }catch(error){
          const code=(error as NodeJS.ErrnoException).code;
          if(code==="ENOENT")throw new Error("Файл или папка уже изменились. Обновите список и повторите действие.");
          if(code==="ENOTEMPTY"||code==="EEXIST")throw new Error("Папка изменилась во время удаления. Обновите список и повторите действие.");
          throw error;
        }
        return {path:entry.path,kind:entry.kind};
      }
      case "gitStatus":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileGitStatus(sessionId,chatId);
      }
      case "gitDiff":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileGitDiff(sessionId,chatId,args);
      }
      case "gitConflictStages":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        return this.mobileGitConflictStages(sessionId,chatId,args);
      }
      case "gitResolveConflictStage":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        this.requireIdleMobileRuntime(sessionId,chatId);
        return this.mobileResolveConflictStage(sessionId,chatId,args);
      }
      case "gitStage":
      case "gitUnstage":
      case "gitCommit":
      case "gitCreateBranch":
      case "gitSwitchBranch":
      case "gitTrackRemoteBranch":
      case "gitFetch":
      case "gitPull":
      case "gitPush":{
        if(!await this.canReadSession(sessionId,chatId))throw new Error("Доступ к сеансу запрещён");
        this.requireIdleMobileRuntime(sessionId,chatId);
        const {root,name}=this.mobileRoot(sessionId,chatId);
        const gitRoot=this.gitRoot(root);
        if(job.op==="gitStage"||job.op==="gitUnstage"){
          const paths=[this.mobileGitPath(root,argumentString(args,"path",1200))];
          if(job.op==="gitUnstage"&&typeof args.previousPath==="string")paths.push(this.mobileGitPath(root,args.previousPath));
          if(job.op==="gitStage"){
            try{
              const entry=this.mobileProjectEntry(root,paths[0]!);
              if(entry.kind==="directory")throw new Error("Добавляйте в индекс отдельные файлы, а не папки: в папке могут быть скрытые изменения");
            }catch(error){
              if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
              const tracked=this.gitOutput(gitRoot,["--literal-pathspecs","ls-files","-z","--",paths[0]!],128*1024).split("\0").filter(Boolean);
              if(tracked.some(path=>path.startsWith(paths[0]!+"/")))throw new Error("Добавляйте в индекс отдельные файлы, а не удалённые папки: внутри могут быть скрытые изменения");
            }
          }
          const gitArgs=job.op==="gitStage"?["--literal-pathspecs","add","--all","--",...paths]:this.gitHasHead(gitRoot)?["--literal-pathspecs","reset","-q","HEAD","--",...paths]:["--literal-pathspecs","rm","--cached","--quiet","--ignore-unmatch","--",...paths];
          this.gitMutation(gitRoot,gitArgs);
          return {paths,staged:job.op==="gitStage"};
        }
        if(job.op==="gitCommit"){
          const message=argumentString(args,"message",200).trim();
          if(!message||/[\u0000-\u001f\u007f]/.test(message))throw new Error("Укажите короткое однострочное сообщение коммита");
          if(this.mobileGitStatus(sessionId,chatId).hasHiddenStagedChanges)throw new Error("Коммит с телефона заблокирован: в индексе есть изменения скрытых или служебных файлов, которые здесь не показываются");
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
        if(job.op==="gitPull"){
          const before=this.mobileGitStatus(sessionId,chatId);
          const upstream=before.upstream;
          if(!upstream)throw new Error("У текущей ветки нет загруженной отслеживаемой ветки для получения обновлений");
          if(!before.clean)throw new Error("Перед получением обновлений закоммитьте или уберите все незакоммиченные изменения");
          if(!before.remoteBranches.includes(upstream))throw new Error("Отслеживаемая ветка больше не найдена. Обновите Git и проверьте настройки ветки");
          const separator=upstream.indexOf("/");
          if(separator<1||separator===upstream.length-1)throw new Error("Не удалось определить удалённую ветку для получения обновлений");
          const remoteName=upstream.slice(0,separator);
          this.requireMobileGitRemote(gitRoot,remoteName,"fetch");
          const previousCommit=this.gitOutput(gitRoot,["rev-parse","--verify","HEAD"],4096).trim();
          await this.mobileGitRemoteCommand(gitRoot,["fetch","--no-tags","--no-recurse-submodules",remoteName],"fetch");
          const current=this.mobileGitStatus(sessionId,chatId);
          if(current.branch!==before.branch||current.upstream!==upstream)throw new Error("Текущая ветка Git изменилась. Обновите состояние и повторите действие");
          if(!current.clean)throw new Error("Рабочая папка изменилась во время загрузки. Не применены никакие обновления");
          if(!current.remoteBranches.includes(upstream))throw new Error("Загруженная отслеживаемая ветка недоступна");
          this.gitMutation(gitRoot,["merge","--ff-only","--no-edit","--",`refs/remotes/${upstream}`],120_000);
          const next=this.mobileGitStatus(sessionId,chatId);
          return {branch:next.branch,upstream,updated:this.gitOutput(gitRoot,["rev-parse","--verify","HEAD"],4096).trim()!==previousCommit};
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
  private issueMobileMcpResourceRefs(
    ownerId:number,
    sessionId:string,
    inventory:unknown,
  ):Map<string,MobileMcpResourceSummary[]>{
    const result=new Map<string,MobileMcpResourceSummary[]>();
    if(!sessionId)return result;
    const now=Date.now();
    for(const [id,ref] of this.mobileMcpResources){
      if(ref.expiresAt<=now||(ref.ownerId===ownerId&&ref.sessionId===sessionId))this.mobileMcpResources.delete(id);
    }
    if(!Array.isArray(inventory))return result;
    const clean=(value:unknown,max:number)=>typeof value==="string"
      ? value.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max)||undefined
      : undefined;
    let issued=0;
    for(const rawServer of inventory.slice(0,100)){
      if(!rawServer||typeof rawServer!=="object"||Array.isArray(rawServer))continue;
      const serverRecord=rawServer as Record<string,unknown>;
      const serverName=clean(serverRecord.name,120);
      if(!serverName)continue;
      const rawResources=Array.isArray(serverRecord.resources)?serverRecord.resources:[];
      const rawTemplates=Array.isArray(serverRecord.resourceTemplates)?serverRecord.resourceTemplates:[];
      if(!rawResources.length&&!rawTemplates.length)continue;
      const summaries:MobileMcpResourceSummary[]=[];
      const entries=[
        ...rawResources.slice(0,50).map((value)=>({value,kind:"resource" as const})),
        ...rawTemplates.slice(0,50).map((value)=>({value,kind:"template" as const})),
      ];
      for(const [index,entry] of entries.entries()){
        if(issued>=500)break;
        const rawResource=entry.value;
        if(!rawResource||typeof rawResource!=="object"||Array.isArray(rawResource))continue;
        const resource=rawResource as Record<string,unknown>;
        const uri=entry.kind==="resource"?resource.uri:undefined;
        const uriTemplate=entry.kind==="template"?resource.uriTemplate:undefined;
        const parameters=typeof uriTemplate==="string"?mobileMcpResourceTemplateParameters(uriTemplate):undefined;
        if(entry.kind==="resource"&& (typeof uri!=="string"||!uri.trim()||uri.length>2048||/[\u0000-\u001f\u007f]/.test(uri)))continue;
        if(entry.kind==="template"&&!parameters)continue;
        const id=randomUUID();
        this.mobileMcpResources.set(id,{
          ownerId,sessionId,serverName,
          ...(typeof uri==="string"?{uri}:{}),
          ...(typeof uriTemplate==="string"?{uriTemplate}:{}),
          expiresAt:now+10*60_000,
        });
        const name=clean(resource.name,160)??`Ресурс ${index+1}`;
        const description=clean(resource.description,300);
        const mimeType=clean(resource.mimeType,100);
        summaries.push({id,name,...(description?{description}:{}),...(mimeType?{mimeType}:{}),...(parameters?{parameters}:{})});
        issued++;
      }
      if(summaries.length)result.set(serverName,summaries);
    }
    while(this.mobileMcpResources.size>3000){
      const oldest=this.mobileMcpResources.keys().next().value;
      if(oldest===undefined)break;
      this.mobileMcpResources.delete(oldest);
    }
    return result;
  }
  private issueMobileEditableTurnCursor(ownerId:number,sessionId:string,cursor:string,latestTurnId:string):string{
    const now=Date.now();
    for(const [id,ref] of this.mobileEditableTurnCursors)if(ref.expiresAt<=now)this.mobileEditableTurnCursors.delete(id);
    const id=randomUUID();
    this.mobileEditableTurnCursors.set(id,{ownerId,sessionId,cursor,latestTurnId,expiresAt:now+10*60_000});
    while(this.mobileEditableTurnCursors.size>3000){
      const oldest=this.mobileEditableTurnCursors.keys().next().value;
      if(oldest===undefined)break;
      this.mobileEditableTurnCursors.delete(oldest);
    }
    return id;
  }
  private requireIdleMobileRuntime(sessionId:string,userId:number):void{
    const runtime=this.deps.registry.runtimeForSession(userId,sessionId);
    if(!runtime)throw new Error("Сначала подключите сеанс к мобильному клиенту");
    if(runtime.isBusy)throw new Error("Дождитесь завершения текущей задачи Codex перед изменением настроек или файлов проекта");
  }
  private async startMobilePty(ownerId:number,sessionId:string,cwd:string,requestedShell:unknown){
    const selectedShell=resolveMobileTerminalShell(requestedShell);
    const existing=[...this.mobilePtys.values()].find(item=>item.ownerId===ownerId&&item.sessionId===sessionId&&!item.exited&&!item.closed);
    if(existing){this.touchMobilePty(existing);return {terminalId:existing.terminalId,shell:existing.shell,shellId:existing.shellId,reused:true,exited:false};}
    for(const item of this.mobilePtys.values())if(item.ownerId===ownerId&&item.sessionId===sessionId){
      this.mobilePtys.delete(item.terminalId);this.disposeMobilePty(item);
    }
    let factory=this.deps.mobilePtyFactory;
    if(!factory){
      try{factory=(await import("@homebridge/node-pty-prebuilt-multiarch")).spawn as MobilePtyFactory;}
      catch{throw new Error("Интерактивный терминал недоступен в этой установке; используйте запуск одной команды");}
    }
    const shell=selectedShell.executable;
    const pty=factory(shell,selectedShell.args,{
      name:"xterm-256color",cols:80,rows:24,cwd,encoding:"utf8",
      env:{...process.env,TERM:"xterm-256color"},
    });
    const terminal:MobilePtyRecord={terminalId:randomUUID(),ownerId,sessionId,shell:basename(shell),shellId:selectedShell.id,pty,
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
    return {terminalId:terminal.terminalId,shell:terminal.shell,shellId:terminal.shellId,reused:false,exited:false};
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
  private mobileProjectEntry(root:string,rawPath:string):{absolute:string;parent:string;path:string;name:string;kind:"file"|"directory";size:number;mtimeMs:number}{
    if(!rawPath||isAbsolute(rawPath)||/^[a-z]:/i.test(rawPath)||rawPath.startsWith("\\\\"))throw new Error("Ожидался путь внутри проекта");
    const parts=rawPath.split(/[\\/]+/).filter(Boolean);
    if(!parts.length||parts.some(part=>part==="."||part===".."||part.includes(":")||part.includes("\0")))throw new Error("Недопустимый путь внутри проекта");
    if(parts.some(part=>this.isHiddenMobileFile(part)))throw new Error("Этот путь недоступен в мобильном просмотре");
    const absolute=this.mobilePath(root,parts.join("/"));
    const info=lstatSync(absolute);
    if(info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory()))throw new Error("Можно менять только обычные файлы и папки проекта");
    const parent=realpathSync.native(dirname(absolute));
    if(!isPathWithinRoot(root,parent))throw new Error("Путь выходит за пределы проекта");
    return {absolute,parent,path:relative(root,absolute).split(sep).join("/"),name:basename(absolute),kind:info.isDirectory()?"directory":"file",size:info.isFile()?info.size:0,mtimeMs:info.mtimeMs};
  }
  private assertMobileEntrySnapshot(entry:ReturnType<MiniAppAgent["mobileProjectEntry"]>,args:Record<string,unknown>):void{
    if(args.expectedKind!==entry.kind||typeof args.expectedMtimeMs!=="number"||args.expectedMtimeMs!==entry.mtimeMs||
      (entry.kind==="file"&&(typeof args.expectedSize!=="number"||args.expectedSize!==entry.size)))throw new Error("Файл или папка изменились после просмотра. Обновите список и повторите действие.");
  }
  private removeMobileEntryTree(root:string,absolute:string):void{
    const maximumEntries=10_000;
    type Snapshot={path:string;kind:"file"|"directory"|"symlink";dev:string;ino:string;size:string;mtimeMs:string;ctimeMs:string};
    const snapshot=(path:string,info:ReturnType<typeof lstatSync>):Snapshot=>{
      if(!info)throw new Error("Файл или папка уже изменились. Обновите список файлов.");
      return {path,kind:info.isSymbolicLink()?"symlink":info.isDirectory()?"directory":"file",dev:String(info.dev),ino:String(info.ino),size:String(info.size),mtimeMs:String(info.mtimeMs),ctimeMs:String(info.ctimeMs)};
    };
    const same=(left:Snapshot,right:Snapshot):boolean=>left.kind===right.kind&&left.dev===right.dev&&left.ino===right.ino&&left.size===right.size&&left.mtimeMs===right.mtimeMs&&left.ctimeMs===right.ctimeMs;
    const assertParentInRoot=(path:string):void=>{
      const parent=realpathSync.native(dirname(path));
      if(!isPathWithinRoot(root,parent))throw new Error("Путь выходит за пределы проекта");
    };
    const pending:Array<{path:string;afterChildren:boolean}>=[{path:absolute,afterChildren:false}];
    const removalOrder:Snapshot[]=[];
    while(pending.length){
      const current=pending.pop()!;
      if(!isPathWithinRoot(root,current.path))throw new Error("Папка выходит за пределы проекта");
      assertParentInRoot(current.path);
      const info=lstatSync(current.path);
      if(current.afterChildren){
        if(info.isSymbolicLink()||!info.isDirectory())throw new Error("Папка изменилась во время удаления. Обновите список файлов.");
        removalOrder.push(snapshot(current.path,info));
        continue;
      }
      if(info.isSymbolicLink()||info.isFile())removalOrder.push(snapshot(current.path,info));
      else if(info.isDirectory()){
        pending.push({path:current.path,afterChildren:true});
        const names=readdirSync(current.path);
        if(removalOrder.length+pending.length+names.length>maximumEntries)throw new Error("Папка содержит слишком много элементов для безопасного удаления с телефона");
        for(const name of names){
          const child=resolve(current.path,name);
          if(!isPathWithinRoot(root,child))throw new Error("Путь выходит за пределы проекта");
          pending.push({path:child,afterChildren:false});
        }
      }else throw new Error("Удалять можно только обычные файлы, папки и символические ссылки");
      if(removalOrder.length+pending.length>maximumEntries)throw new Error("Папка содержит слишком много элементов для безопасного удаления с телефона");
    }
    for(const expected of removalOrder){
      assertParentInRoot(expected.path);
      const current=snapshot(expected.path,lstatSync(expected.path));
      if(!same(expected,current))throw new Error("Содержимое папки изменилось после просмотра. Обновите список и повторите действие.");
    }
    for(const expected of removalOrder){
      assertParentInRoot(expected.path);
      const info=lstatSync(expected.path);
      const current=snapshot(expected.path,info);
      if(current.kind!==expected.kind||current.dev!==expected.dev||current.ino!==expected.ino)throw new Error("Папка изменилась во время удаления. Обновите список файлов.");
      if(expected.kind==="directory")rmdirSync(expected.path);
      else if(expected.kind==="symlink"){
        let targetIsDirectory=false;
        try{targetIsDirectory=statSync(expected.path).isDirectory();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        if(targetIsDirectory&&process.platform==="win32")rmdirSync(expected.path);
        else unlinkSync(expected.path);
      }else unlinkSync(expected.path);
    }
  }
  private mobileEntryName(rawName:string):string{
    const name=rawName.trim();
    if(!name||name!==rawName||name==="."||name===".."||/[<>:"/\\|?*\u0000-\u001f]/.test(name)||/[. ]$/.test(name)||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)||this.isHiddenMobileFile(name))throw new Error("Недопустимое имя файла или папки");
    return name;
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
  private mobileFileList(sessionId:string,userId:number,rawPath:string,offset:number){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const directory=rawPath?this.mobilePath(root,rawPath):root;
    if(!statSync(directory).isDirectory())throw new Error("Это не папка проекта");
    const allEntries=readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
      if(this.isHiddenMobileFile(entry.name))return [];
      const absolute=resolve(directory,entry.name);
      try{
        const info=lstatSync(absolute);
        if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))return [];
        return [{name:entry.name,kind:info.isDirectory()?"directory" as const:"file" as const,
          size:info.isFile()?info.size:undefined,mtimeMs:info.mtimeMs}];
      }catch{return [];}
    }).sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):a.kind==="directory"?-1:1);
    const entries=allEntries.slice(offset,offset+250);
    const nextOffset=offset+entries.length<allEntries.length?offset+entries.length:undefined;
    return {project:name,path:rawPath.split(/[\\/]+/).filter(Boolean).join("/"),entries,total:allEntries.length,...(nextOffset===undefined?{}:{nextOffset})};
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
  private mobileDownloadFile(sessionId:string,userId:number,rawPath:string):{name:string;size:number;bytes:Buffer}{
    const {root}=this.mobileRoot(sessionId,userId);
    const entry=this.mobileProjectEntry(root,rawPath);
    if(entry.kind!=="file")throw new Error("Скачивать можно только обычный файл проекта");
    if(entry.size>MAX_MOBILE_DOWNLOAD_BYTES)throw new Error("Файл должен быть не больше 10 МБ");
    const before=lstatSync(entry.absolute);
    if(before.isSymbolicLink()||!before.isFile()||before.size>MAX_MOBILE_DOWNLOAD_BYTES||
      !isPathWithinRoot(root,realpathSync.native(dirname(entry.absolute))))throw new Error("Файл изменился. Обновите список проекта и повторите скачивание.");
    const descriptor=openSync(entry.absolute,"r");
    try{
      const opened=fstatSync(descriptor);
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>MAX_MOBILE_DOWNLOAD_BYTES)
        throw new Error("Файл изменился. Обновите список проекта и повторите скачивание.");
      const buffer=Buffer.alloc(MAX_MOBILE_DOWNLOAD_BYTES+1);
      let length=0;
      while(length<buffer.length){
        const count=readSync(descriptor,buffer,length,buffer.length-length,length);
        if(count===0)break;
        length+=count;
      }
      if(length>MAX_MOBILE_DOWNLOAD_BYTES)throw new Error("Файл должен быть не больше 10 МБ");
      const after=fstatSync(descriptor);
      const current=lstatSync(entry.absolute);
      if(current.isSymbolicLink()||!current.isFile()||current.dev!==opened.dev||current.ino!==opened.ino||
        current.size!==opened.size||current.mtimeMs!==opened.mtimeMs||current.ctimeMs!==opened.ctimeMs||
        after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
        !isPathWithinRoot(root,realpathSync.native(dirname(entry.absolute)))||length!==opened.size)
        throw new Error("Файл изменился во время скачивания. Обновите список проекта и повторите действие.");
      return {name:entry.name,size:length,bytes:buffer.subarray(0,length)};
    }finally{closeSync(descriptor);}
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
    const tokens=this.gitOutput(gitRoot,["status","--porcelain=v1","--branch","--untracked-files=all","-z"],512*1024).split("\0");
    const first=(tokens.shift()??"").split(/\r?\n/);
    const header=(first.shift()??"").replace(/\r$/g,"");
    const branch=header.startsWith("## ")?header.slice(3).split("...")[0]?.split(" [")[0]?.slice(0,160)??"":"";
    const lines=[...first,...tokens].filter(Boolean);
    const changes:Array<{code:string;indexStatus:string;worktreeStatus:string;path:string;previousPath?:string}> = [];
    let realChangeCount=0;
    let hiddenChangeCount=0;
    let hasStagedChanges=false;
    let hasHiddenStagedChanges=false;
    for(let i=0;i<lines.length;i++){
      const line=lines[i]!;
      const code=line.slice(0,2);
      const path=line.slice(3);
      const renamed=/[RC]/.test(code);
      const previousPath=renamed?lines[++i]:undefined;
      realChangeCount++;
      const staged=code[0]!==" "&&code[0]!=="?";
      hasStagedChanges||=staged;
      const hidden=this.isHiddenMobileGitPath(path)||(previousPath&&this.isHiddenMobileGitPath(previousPath))===true;
      if(hidden){
        hiddenChangeCount++;
        hasHiddenStagedChanges||=staged;
        continue;
      }
      if(changes.length>=250)continue;
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
    const upstreamCandidate=header.includes("...")?header.slice(header.indexOf("...")+3).split(" ")[0]:undefined;
    const upstream=upstreamCandidate&&remoteBranches.includes(upstreamCandidate)?upstreamCandidate:undefined;
    return {project:name,branch,branches,remoteBranches,remotes,...(upstream?{upstream}:{}),clean:realChangeCount===0,
      hasStagedChanges,hasHiddenChanges:hiddenChangeCount>0,hasHiddenStagedChanges,hiddenChangeCount,changes,checkedAt:Date.now()};
  }
  private isHiddenMobileGitPath(path:string):boolean{
    return path.split(/[\\/]+/).some(part=>this.isHiddenMobileFile(part));
  }
  private mobileGitDiff(sessionId:string,userId:number,args:Record<string,unknown>={}){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const gitRoot=this.gitRoot(root);
    const paths:string[]=[];
    if(typeof args.path==="string")paths.push(this.mobileGitPath(root,args.path));
    if(typeof args.previousPath==="string")paths.push(this.mobileGitPath(root,args.previousPath));
    const status=this.mobileGitStatus(sessionId,userId);
    const relevantChanges=paths.length
      ?status.changes.filter(change=>paths.includes(change.path)||(change.previousPath&&paths.includes(change.previousPath)))
      :status.changes;
    const diffPaths=paths.length?[...new Set(paths)]:[...new Set(relevantChanges.flatMap(change=>[change.path,...(change.previousPath?[change.previousPath]:[])]))];
    const safeArgs=["--literal-pathspecs","diff","--no-ext-diff","--no-textconv","--no-color","--unified=3"];
    const readDiff=(cached:boolean):string=>{
      const chunks:string[]=[];
      let totalBytes=0;
      for(let offset=0;offset<diffPaths.length;offset+=16){
        const pathArgs=["--",...diffPaths.slice(offset,offset+16)];
        const output=this.gitOutput(gitRoot,[...safeArgs,...(cached?["--cached"]:[]),...pathArgs],MAX_MOBILE_GIT_DIFF_BYTES);
        totalBytes+=Buffer.byteLength(output,"utf8");
        if(totalBytes>MAX_MOBILE_GIT_DIFF_BYTES)throw new Error("Diff больше 2 МБ. Откройте отдельный файл.");
        chunks.push(output);
      }
      return chunks.join("");
    };
    const unstaged=readDiff(false);
    const staged=readDiff(true);
    const untracked=relevantChanges.filter(change=>change.code==="??");
    const untrackedDiffs:string[]=[];
    let untrackedBytes=Buffer.byteLength(unstaged,"utf8");
    for(const change of untracked){
      const diff=this.mobileGitUntrackedDiff(root,change.path);
      untrackedBytes+=Buffer.byteLength(diff,"utf8");
      if(untrackedBytes>MAX_MOBILE_GIT_DIFF_BYTES)throw new Error("Новые файлы занимают больше 2 МБ. Откройте их diff по одному.");
      untrackedDiffs.push(diff);
    }
    return {project:name,unstaged:[unstaged,...untrackedDiffs].filter(Boolean).join("\n"),staged,checkedAt:Date.now()};
  }
  private mobileGitUntrackedDiff(root:string,rawPath:string):string{
    const entry=this.mobileProjectEntry(root,rawPath);
    if(entry.kind!=="file")throw new Error("Diff нового файла доступен только для обычных файлов");
    if(/[\u0000-\u001f\u007f]/.test(entry.path))throw new Error("Имя файла нельзя безопасно показать в diff");
    if(entry.size>MAX_MOBILE_GIT_UNTRACKED_DIFF_BYTES)throw new Error("Новый файл больше 512 КБ и не открывается в Git diff");
    const before=lstatSync(entry.absolute);
    if(before.isSymbolicLink()||!before.isFile()||!isPathWithinRoot(root,realpathSync.native(dirname(entry.absolute))))
      throw new Error("Новый файл изменился. Обновите Git и повторите просмотр.");
    const descriptor=openSync(entry.absolute,"r");
    try{
      const opened=fstatSync(descriptor);
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>MAX_MOBILE_GIT_UNTRACKED_DIFF_BYTES)
        throw new Error("Новый файл изменился. Обновите Git и повторите просмотр.");
      const bytes=Buffer.alloc(MAX_MOBILE_GIT_UNTRACKED_DIFF_BYTES+1);
      let length=0;
      while(length<bytes.length){
        const count=readSync(descriptor,bytes,length,bytes.length-length,length);
        if(count===0)break;
        length+=count;
      }
      if(length>MAX_MOBILE_GIT_UNTRACKED_DIFF_BYTES)throw new Error("Новый файл больше 512 КБ и не открывается в Git diff");
      const after=fstatSync(descriptor);
      const current=lstatSync(entry.absolute);
      if(current.isSymbolicLink()||!current.isFile()||current.dev!==opened.dev||current.ino!==opened.ino||
        current.size!==opened.size||current.mtimeMs!==opened.mtimeMs||current.ctimeMs!==opened.ctimeMs||
        after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
        !isPathWithinRoot(root,realpathSync.native(dirname(entry.absolute)))||length!==opened.size)
        throw new Error("Новый файл изменился во время чтения. Обновите Git и повторите просмотр.");
      const path=entry.path;
      const header=[`diff --git a/${path} b/${path}`,`new file mode ${(opened.mode&0o111)?"100755":"100644"}`];
      if(bytes.subarray(0,length).includes(0))return [...header,`Binary files /dev/null and b/${path} differ`].join("\n");
      let text:string;
      try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length));}
      catch{return [...header,`Binary files /dev/null and b/${path} differ`].join("\n");}
      const patch=structuredPatch("/dev/null",`b/${path}`,"",text,"","",{context:3});
      const hunks=patch.hunks.flatMap(hunk=>[
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ]);
      return [...header,"--- /dev/null",`+++ b/${path}`,...hunks].join("\n");
    }finally{closeSync(descriptor);}
  }
  private gitConflictBlobSize(root:string,objectId:string):number{
    const sizeText=this.gitOutput(root,["cat-file","-s",objectId],1024).trim();
    if(!/^\d{1,9}$/.test(sizeText))throw new Error("Git вернул неверный размер версии конфликта");
    return Number(sizeText);
  }
  private gitConflictBlobBytes(root:string,objectId:string,maxBytes:number):{size:number;bytes:Buffer}{
    const size=this.gitConflictBlobSize(root,objectId);
    if(size>maxBytes)throw new Error(`Версия конфликта больше ${Math.floor(maxBytes/1024/1024)} МБ и не открывается на телефоне`);
    let bytes:Buffer;
    try{
      bytes=execFileSync("git",["--no-pager","-C",root,"-c","core.fsmonitor=false","cat-file","blob",objectId],{
        encoding:null,timeout:8000,maxBuffer:maxBytes+1,windowsHide:true,stdio:["ignore","pipe","ignore"],
      });
    }catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOBUFS")throw new Error("Версия конфликта превышает безопасный лимит для телефона");
      throw new Error("Не удалось прочитать версию конфликта из Git");
    }
    if(bytes.length!==size)throw new Error("Git вернул неполную версию конфликтного файла");
    return {size,bytes};
  }
  private gitConflictBlobText(root:string,objectId:string):string{
    const {bytes}=this.gitConflictBlobBytes(root,objectId,MAX_MOBILE_CONFLICT_STAGE_BYTES);
    if(bytes.includes(0))throw new Error("Бинарный конфликт нельзя открыть как текст");
    try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
    catch{throw new Error("Версия конфликта не является корректным UTF-8 текстом");}
  }
  private mobileGitConflictEntries(gitRoot:string,path:string){
    const records=this.gitOutput(gitRoot,["ls-files","--unmerged","-z","--",path],64*1024).split("\0").filter(Boolean);
    const stages=new Map<number,{mode:string;objectId:string}>();
    for(const record of records){
      const tab=record.indexOf("\t");
      if(tab<0||record.slice(tab+1)!==path)continue;
      const [mode,objectId,stageText]=record.slice(0,tab).split(" ");
      const stage=Number(stageText);
      if(!mode||!/^\d{6}$/.test(mode)||!objectId||!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(objectId)||![1,2,3].includes(stage))continue;
      if(stages.has(stage))throw new Error("Git вернул несколько вариантов одной стадии конфликта");
      stages.set(stage,{mode,objectId});
    }
    if(!stages.size)throw new Error("Файл не находится в состоянии конфликта Git");
    return stages;
  }
  private mobileGitConflictTarget(root:string,path:string):{absolute:string;parent:string;exists:boolean;mode:number;size:number}{
    const parts=path.split("/").filter(Boolean);
    if(!parts.length)throw new Error("Недопустимый путь Git");
    let parent=root;
    for(const part of parts.slice(0,-1)){
      parent=resolve(parent,part);
      let info;
      try{info=lstatSync(parent);}catch{throw new Error("Папка конфликтного файла больше недоступна");}
      if(info.isSymbolicLink()||!info.isDirectory())throw new Error("Путь конфликтного файла содержит ссылку или не является папкой");
    }
    const absolute=resolve(parent,parts.at(-1)!);
    if(!isPathWithinRoot(root,absolute))throw new Error("Путь Git выходит за пределы проекта");
    try{
      const info=lstatSync(absolute);
      if(info.isSymbolicLink()||!info.isFile())throw new Error("Конфликтный путь не является обычным файлом");
      return {absolute,parent,exists:true,mode:info.mode&0o777,size:info.size};
    }catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOENT")return {absolute,parent,exists:false,mode:0,size:0};
      throw error;
    }
  }
  private mobileGitConflictStages(sessionId:string,userId:number,args:Record<string,unknown>={}){
    const {root,name}=this.mobileRoot(sessionId,userId);
    const gitRoot=this.gitRoot(root);
    const path=this.mobileGitPath(root,argumentString(args,"path",1200));
    const stages=this.mobileGitConflictEntries(gitRoot,path);
    const names=new Map<number,"base"|"ours"|"theirs">([[1,"base"],[2,"ours"],[3,"theirs"]]);
    const textStages:Partial<Record<"base"|"ours"|"theirs",string>>={};
    const binaryStages:Array<"base"|"ours"|"theirs">=[];
    const unsupportedStages:Array<"base"|"ours"|"theirs">=[];
    for(const [stage,value] of stages){
      const stageName=names.get(stage)!;
      if(value.mode!=="100644"&&value.mode!=="100755"){unsupportedStages.push(stageName);continue;}
      const size=this.gitConflictBlobSize(gitRoot,value.objectId);
      if(size>MAX_MOBILE_BINARY_CONFLICT_BYTES){unsupportedStages.push(stageName);continue;}
      const {bytes}=this.gitConflictBlobBytes(gitRoot,value.objectId,MAX_MOBILE_BINARY_CONFLICT_BYTES);
      if(size>MAX_MOBILE_CONFLICT_STAGE_BYTES||bytes.includes(0)){binaryStages.push(stageName);continue;}
      try{textStages[stageName]=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
      catch{binaryStages.push(stageName);}
    }
    const target=this.mobileGitConflictTarget(root,path);
    const worktreeSha256=binaryStages.length===0?undefined:target.exists&&target.size<=MAX_MOBILE_BINARY_CONFLICT_BYTES
      ?createHash("sha256").update(readFileSync(target.absolute)).digest("hex")
      :target.exists?undefined:null;
    return {
      project:name,path,
      ...textStages,
      ...(binaryStages.length?{binaryStages}:{}),
      ...(unsupportedStages.length?{unsupportedStages}:{}),
      ...(worktreeSha256!==undefined?{worktreeSha256}:{}),
    };
  }
  private mobileResolveConflictStage(sessionId:string,userId:number,args:Record<string,unknown>={}){
    const {root}=this.mobileRoot(sessionId,userId);
    const gitRoot=this.gitRoot(root);
    const path=this.mobileGitPath(root,argumentString(args,"path",1200));
    const stageName=argumentString(args,"stage",8);
    const stageNumber=stageName==="base"?1:stageName==="ours"?2:stageName==="theirs"?3:0;
    if(!stageNumber)throw new Error("Выберите одну из версий конфликта Git");
    const selected=this.mobileGitConflictEntries(gitRoot,path).get(stageNumber);
    if(!selected)throw new Error("Выбранная версия конфликта больше недоступна");
    if(selected.mode!=="100644"&&selected.mode!=="100755")throw new Error("Символьные ссылки и подмодули пока нельзя выбрать с телефона");
    const {size,bytes}=this.gitConflictBlobBytes(gitRoot,selected.objectId,MAX_MOBILE_BINARY_CONFLICT_BYTES);
    const expectedHash=args.expectedHash;
    if(expectedHash!==null&&!(typeof expectedHash==="string"&&/^[a-f0-9]{64}$/.test(expectedHash)))throw new Error("Состояние файла устарело. Обновите конфликт и повторите выбор.");
    const target=this.mobileGitConflictTarget(root,path);
    if(target.size>MAX_MOBILE_BINARY_CONFLICT_BYTES)throw new Error("Текущий файл больше 10 МБ; обновите конфликт после ручного разрешения");
    const currentHash=target.exists?createHash("sha256").update(readFileSync(target.absolute)).digest("hex"):null;
    if(currentHash!==expectedHash)throw new Error("Файл изменился после открытия. Обновите конфликт перед заменой.");
    const temp=target.absolute+".codex-mobile-"+randomBytes(8).toString("hex")+".tmp";
    try{
      writeFileSync(temp,bytes,{flag:"wx",mode:selected.mode==="100755"?0o755:0o644});
      const fresh=this.mobileGitConflictEntries(gitRoot,path).get(stageNumber);
      if(!fresh||fresh.objectId!==selected.objectId||fresh.mode!==selected.mode)throw new Error("Версии конфликта изменились. Обновите Git и повторите выбор.");
      const latestTarget=this.mobileGitConflictTarget(root,path);
      const latestHash=latestTarget.exists?createHash("sha256").update(readFileSync(latestTarget.absolute)).digest("hex"):null;
      if(latestHash!==expectedHash)throw new Error("Файл изменился во время выбора. Обновите конфликт и повторите попытку.");
      renameSync(temp,target.absolute);
    }finally{try{unlinkSync(temp);}catch{/* rename already removed the temporary file */}}
    this.gitMutation(gitRoot,["add","--all","--",path]);
    return {path,stage:stageName,size,sha256:createHash("sha256").update(bytes).digest("hex")};
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
  lookupMobileSend(userId:number,args:Record<string,unknown>):{found:boolean;result?:unknown}{
    const sessionId=argumentString(args,"sessionId",80);
    const requestId=argumentString(args,"requestId",80);
    if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))throw new Error("Неверный идентификатор запроса");
    const rawIds=args.attachmentIds;
    if(!Array.isArray(rawIds)||rawIds.length<1||rawIds.length>5||rawIds.some(id=>typeof id!=="string"))
      throw new Error("Список вложений недопустим или превышает пять файлов");
    const attachmentIds=rawIds as string[];
    if(attachmentIds.some(id=>!/^[a-f0-9-]{36}$/i.test(id))||new Set(attachmentIds).size!==attachmentIds.length)
      throw new Error("Список вложений недопустим или превышает пять файлов");
    const text=typeof args.text==="string"&&args.text.length<=16000?args.text.trim():"";
    const images=parseTmaImages(args.images);
    const appIds=selectedMobileAppIds(args.appIds);
    const fingerprint=tmaPromptFingerprint(text,images,[
      ...attachmentIds,
      ...appIds.map(appId=>"app:"+appId),
    ]);
    return this.promptJournal.lookup(userId+":"+sessionId+":"+requestId,fingerprint);
  }
  async execute(job:TmaJob,mobileAttachments:readonly MobilePromptAttachment[]=[],context?:{surface:"mobile"}):Promise<unknown>{
    const {acp,registry,cfg}=this.deps;
    const chatId=job.userId,controller=registry.controller(chatId),args=job.args;
    const allowBrowserTemp=context?.surface==="mobile";
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
        const [projects,page]=await Promise.all([
          this.mobileProjectsFor(chatId),
          this.mobileThreadPage(chatId,{archived:false}),
        ]);
        const threads=page.threads;
        let sections:Awaited<ReturnType<AcpClient["listThreadSections"]>>=[];
        let sectionsAvailable=false;
        const archiveAvailable=acp.isConnected;
        if(acp.isConnected&&typeof acp.listThreadSections==="function"){
          try{sections=await acp.listThreadSections();sectionsAvailable=true;}
          catch(error){log.warn("Could not read Codex thread sections:",(error as Error).message);}
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
        const sessions=threads.map(t=>{
          const status=normalizeThreadStatus(t.status);
          const current=controlled.find(c=>c.sessionId===t.id);
          return {
            id:t.id,title:(t.name||t.preview||"Новый сеанс").slice(0,180),
            cwd:t.cwd||"",updatedAt:t.recencyAt||t.updatedAt||t.createdAt||0,
            source:threadSourceKind(t)||"unknown",
            archived:false,
            ephemeral:t.ephemeral===true,
            parentThreadId:t.parentThreadId,
            section:mobileThreadSection(t.section),
            busy:Boolean(current?.busy)||status?.status==="working"||status?.status==="approval",
            queue:current?.queueLength||0,
            progress:current?.progress,
            liveStatus:status?.status??"unknown",
            liveLabel:status?.label??"Статус неизвестен",
          };
        });
        return {
          projects:[...projectMap].map(([path,name])=>({path,name})),
          sessions,
          sessionsNextCursor:page.nextCursor,
          archivedSessions:[],
          sectionsAvailable,
          sections:sectionsAvailable?[
            {id:CODEX_PINNED_THREAD_SECTION_ID,name:"Закреплённые",builtIn:true},
            ...sections.filter(section=>section.id!==CODEX_PINNED_THREAD_SECTION_ID).map(section=>({id:section.id,name:section.name,builtIn:false})),
          ]:[],
          archiveAvailable,
          selected:this.selected.get(chatId)||active.sessionId||null,
          controlled:controlled.map(c=>({id:c.sessionId,busy:c.busy,queue:c.queueLength,paused:c.queuePaused})),
          model:acp.currentModelId||"default",
          models:acp.availableModels.map(m=>({id:m.modelId,name:m.name})),
          online:acp.isConnected,
        };
      }
      case "activity":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        const path=this.store.jsonlPath(id);
        const file=statSyncSafe(path);
        const rt=registry.runtimeForSession(chatId,id);
        // Scan the evolving rollout while Codex is still working.
        const images=t.cwd?await this.sessionScreenshotImages(id,chatId,allowBrowserTemp):[];
        const status=normalizeThreadStatus(t.status);
        return {mtimeMs:file.mtimeMs,size:file.size,busy:Boolean(rt?.isBusy)||status?.status==="working"||status?.status==="approval",
          queue:rt?.queueLength??0,images,liveStatus:status?.status??"unknown",liveLabel:status?.label??"Статус неизвестен",checkedAt:Date.now()};
      }
      case "history":{
        const id=argumentString(args,"sessionId",80);
        const t=await this.thread(id,chatId);
        const path=this.store.jsonlPath(id);
        const includeTools=args.includeTools===true;
        const cacheKey=id+":"+(includeTools?"tools":"chat")+":"+(allowBrowserTemp?"mobile-images":"project-images");
        // Avoid re-reading multi-megabyte rollout logs every six seconds.
        // A manual refresh still checks the file's current size/mtime first.
        const stat=statSyncSafe(path);
        const cached=this.historyCache.get(cacheKey);
        if(cached&&cached.size===stat.size&&cached.mtimeMs===stat.mtimeMs)return cached.result;
        const key=cacheKey+":"+stat.size+":"+stat.mtimeMs;
        const existing=this.historyInflight.get(key);
        if(existing)return existing;
        const resolveParentPath=async(parentId:string):Promise<string|undefined>=>{
          // Rollout metadata is local input, not authorization. Re-check the
          // parent through this user's Codex catalogue and keep forks inside
          // the same project before following any on-disk path.
          if(!t.cwd)return undefined;
          const parent=await this.thread(parentId,chatId);
          if(!parent.cwd)return undefined;
          const childCwd=resolve(t.cwd),parentCwd=resolve(parent.cwd);
          const sameProject=process.platform==="win32"
            ?childCwd.toLowerCase()===parentCwd.toLowerCase()
            :childCwd===parentCwd;
          return sameProject?this.store.historyJsonlPath(parentId):undefined;
        };
        const pending=(async()=>{
          const entries=(await readConversationHistoryAsync(path,40,32*1024*1024,includeTools,resolveParentPath)).map(e=>({
            role:e.role,text:e.text,timestamp:e.timestamp,tool:e.tool,
          }));
          const refs=t.cwd?await this.sessionScreenshotImages(id,chatId,allowBrowserTemp):[];
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
        const appIds=selectedMobileAppIds(args.appIds);
        if(mobileAttachments.length>5||mobileAttachments.some(file=>!isSafeMobilePromptAttachment(file,cfg.dataDir)))
          throw new Error("Одно из вложений недоступно или имеет неверный формат");
        if(!message&&!images.length&&!mobileAttachments.length)throw new Error("Напиши задачу или прикрепи файл");
        const requestId=argumentString(args,"requestId",80);
        const fingerprint=tmaPromptFingerprint(message,images,[
          ...mobileAttachments.map(file=>file.id),
          ...appIds.map(appId=>"app:"+appId),
        ]);
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
            else await controller.switchTo(id);
            this.selected.set(chatId,id);
            const attachmentContexts=mobileAttachments.map(mobileAttachmentContext);
            const promptText=[message,...attachmentContexts].filter(Boolean).join("\n\n");
            const input=textPrompt(promptText||"Проанализируй прикреплённые изображения.");
            input.images=images;
            if(appIds.length)input.appIds=appIds;
            if(mobileAttachments.length){
              input.attachmentNames=mobileAttachments.map(file=>file.name);
              input.attachmentContext=attachmentContexts.join("\n\n");
              input.attachmentPaths=mobileAttachments.flatMap(file=>file.path?[file.path]:[]);
              input.displayText=message||`Файлы: ${mobileAttachments.map(file=>file.name).join(", ")}`;
            }
            const skillNames=await mobileSkillsRequestedByPrompt(acp,message,t.cwd);
            const selectedSkills=skillNames.filter(name=>!appIds.includes(name));
            if(selectedSkills.length)input.skillNames=selectedSkills;
            // Once this call starts, a crash or ambiguous error may mean Codex
            // already accepted the task; do not automatically resend.
            dispatched=true;
            const result=await registry.submitPrompt(chatId,input,
              context?.surface==="mobile"?{preserveAttachmentsOnBlocked:true}:undefined);
            const answer={result:result.kind==="submitted"?result.outcome:result.kind};
            this.promptJournal.complete(key,answer);
            return answer;
          }catch(error){
            if(dispatched){
              this.promptJournal.uncertain(key);
            }else{
              this.promptJournal.clearBeforeDispatch(key);
              throw new MobileSubmissionRejectedError(error instanceof Error ? error.message : "Задание не было принято", error);
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
        const candidate=argumentString(args,"path",1200);
        return this.readSessionScreenshot(id,chatId,candidate,allowBrowserTemp);
      }
    }
  }
  private async readSessionScreenshot(sessionId:string,userId:number,candidate:string,allowBrowserTemp:boolean){
    const thread=await this.thread(sessionId,userId);
    if(!thread.cwd)throw new Error("Неизвестная папка проекта");
    const sources=await this.mobileScreenshotSources(sessionId,userId);
    let referenced;
    for(const source of sources){
      referenced=await this.screenshots.authorized(source.threadId,source.path,source.cwd,candidate,allowBrowserTemp,source.endByteOffset);
      if(referenced)break;
    }
    if(!referenced)throw new Error("Изображение не относится к этому сеансу");
    const root=realpathSync(thread.cwd),real=realpathSync(candidate);
    const rel=relative(root,real);
    const inWorkspace=Boolean(rel&&rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel));
    const isBrowserScreenshot=allowBrowserTemp&&dirname(real)===realpathSync(tmpdir())&&
      BSK_SCREENSHOT_NAME.test(basename(real))&&!lstatSync(candidate).isSymbolicLink();
    if(!inWorkspace&&!isBrowserScreenshot)throw new Error("Недопустимый путь");
    const ext=extname(real).toLowerCase();
    const mime=({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif"} as Record<string,string>)[ext];
    if(!mime)throw new Error("Неподдерживаемый формат");
    const stat=statSync(real);
    if(!stat.isFile()||stat.size>MAX_IMG)throw new Error("Изображение слишком большое");
    const image=readFileSync(real);
    if(isBrowserScreenshot&&!image.subarray(0,PNG_SIGNATURE.length).equals(PNG_SIGNATURE))throw new Error("Недопустимый формат скриншота Browser Skill");
    return {name:basename(real),mime,data:image.toString("base64")};
  }
  private async mobileScreenshotSources(sessionId:string,userId:number):Promise<MobileScreenshotSource[]>{
    const selected=await this.thread(sessionId,userId);
    if(!selected.cwd)throw new Error("Для этого сеанса Codex не найден проект");
    const childCwd=resolve(selected.cwd);
    const resolveParentPath=async(parentId:string):Promise<string|undefined>=>{
      const parent=await this.thread(parentId,userId);
      if(!parent.cwd)return undefined;
      const parentCwd=resolve(parent.cwd);
      const sameProject=process.platform==="win32"
        ?childCwd.toLowerCase()===parentCwd.toLowerCase()
        :childCwd===parentCwd;
      return sameProject?this.store.historyJsonlPath(parentId):undefined;
    };
    const sources=await conversationHistorySources(this.store.jsonlPath(sessionId),resolveParentPath);
    return sources.map(source=>({
      threadId:source.threadId??sessionId,
      path:source.path,
      cwd:selected.cwd!,
      ...(source.endByteOffset===undefined?{}:{endByteOffset:source.endByteOffset}),
    }));
  }
  private async sessionScreenshotImages(sessionId:string,userId:number,allowBrowserTemp:boolean){
    const sources=await this.mobileScreenshotSources(sessionId,userId);
    const groups=await Promise.all([...sources].reverse().map(source=>
      this.screenshots.scan(source.threadId,source.path,source.cwd,allowBrowserTemp,source.endByteOffset)));
    const unique=new Map<string,Awaited<ReturnType<TmaScreenshotIndex["scan"]>>[number]>();
    for(const image of groups.flat()){
      const key=process.platform==="win32"?image.path.toLowerCase():image.path;
      unique.set(key,image);
    }
    return [...unique.values()].slice(-256);
  }
}

export function startMiniAppAgent(deps:AgentDeps,shared?:MiniAppAgent):MiniAppAgent|undefined{
  const url=(process.env.TMA_GATEWAY_URL||"").trim(),secret=(process.env.TMA_AGENT_TOKEN||"").trim();
  if(!url&&!secret)return undefined;
  if(!url||!secret){log.warn("TMA disabled: specify both TMA_GATEWAY_URL and TMA_AGENT_TOKEN");return undefined;}
  const agent=shared??new MiniAppAgent(deps,url,secret);agent.start();return agent;
}
