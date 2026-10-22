/** Bounded per-session live event feed for Codex Mini App.
 *
 * Events contain only user-facing deltas and tool labels, never raw commands,
 * environment variables, internal RPC params, or file contents.
 * Subscriber authorization is performed by the gateway before connecting.
 */
import { randomBytes } from "node:crypto";
import type { AcpClient } from "../acp/client.js";
import type { SessionUpdate } from "../acp/types.js";

export type LiveStatus="working"|"approval"|"completed"|"failed"|"cancelled"|"observing";
export interface NormalizedThreadStatus { status:LiveStatus; label:string; }

export function normalizeThreadStatus(value:unknown):NormalizedThreadStatus|undefined{
  const raw=value&&typeof value==="object"?value as Record<string,unknown>:undefined;
  const type=typeof value==="string"?value:typeof raw?.type==="string"?raw.type:"";
  const flags=Array.isArray(raw?.activeFlags)?raw.activeFlags.filter((flag):flag is string=>typeof flag==="string"):[];
  if(type==="active"){
    if(flags.includes("waitingOnApproval"))return {status:"approval",label:"Codex ожидает подтверждения"};
    if(flags.includes("waitingOnUserInput"))return {status:"observing",label:"Codex ожидает ответа"};
    return {status:"working",label:"Codex выполняет задание"};
  }
  if(type==="systemError")return {status:"failed",label:"Ошибка состояния Codex"};
  if(type==="idle")return {status:"observing",label:"Codex готов к работе"};
  if(type==="notLoaded")return {status:"observing",label:"Сеанс не загружен в Codex"};
  return undefined;
}
export interface LiveApproval {
  id:string;
  title:string;
  kind:string;
  summary?:string;
  options:Array<{id:string;label:string}>;
}
export interface LiveElicitationField {
  name:string;
  label:string;
  type:"string"|"number"|"integer"|"boolean";
  required:boolean;
  description?:string;
  options?:string[];
  secret?:boolean;
  minLength?:number;
  maxLength?:number;
  minimum?:number;
  maximum?:number;
}
export interface LiveElicitation {
  id:string;
  serverName:string;
  message:string;
  mode:"form"|"url";
  fields?:LiveElicitationField[];
  /** Only HTTPS links are sent; the UI displays the separately sanitized hostname. */
  url?:string;
  urlHost?:string;
}
export interface LiveEvent {
  id:number;
  sessionId:string;
  kind:"text"|"tool"|"status"|"activity"|"approval"|"elicitation"|"transcript"|"plan"|"compaction"|"sync";
  text?:string;
  role?:"user"|"assistant";
  label?:string;
  status?:LiveStatus;
  approval?:LiveApproval;
  turnId?:string;
  explanation?:string;
  plan?:Array<{step:string;status:"pending"|"inProgress"|"completed"}>;
  at:number;
}
const LIMIT=160;
const MAX_THREADS=200;
const str=(v:unknown,max=250)=>typeof v==="string"?v.slice(0,max):"";
function liveFileName(value:unknown):string|undefined{
  if(typeof value!=="string"||!value||value.length>2000)return undefined;
  const name=value.replaceAll("\\","/").split("/").filter(Boolean).at(-1);
  if(!name||name==="."||name===".."||/[\u0000-\u001f\u007f/\\:]/.test(name))return undefined;
  return name.slice(0,100);
}
function safeToolLabel(update:SessionUpdate):string{
  const status=update.status;
  const complete=status==="completed";
  const failed=status==="failed"||status==="declined";
  const file=liveFileName(update.rawInput?.path);
  switch(update.kind){
    case "execute":return failed?"Команда Codex не выполнена":complete?"Команда Codex завершена":"Команда выполняется";
    case "edit":return file?(failed?`Не удалось изменить файл ${file}`:complete?`Изменён файл ${file}`:`Изменяется файл ${file}`)
      :(failed?"Не удалось изменить файл проекта":complete?"Изменён файл проекта":"Изменяется файл проекта");
    case "delete":return file?(failed?`Не удалось удалить файл ${file}`:complete?`Удалён файл ${file}`:`Удаляется файл ${file}`)
      :(failed?"Не удалось удалить файл проекта":complete?"Удалён файл проекта":"Удаляется файл проекта");
    case "move":return file?(failed?`Не удалось переместить файл ${file}`:complete?`Перемещён файл ${file}`:`Перемещается файл ${file}`)
      :(failed?"Не удалось переместить файл проекта":complete?"Перемещён файл проекта":"Перемещается файл проекта");
    case "search":return failed?"Поиск файлов не выполнен":complete?"Поиск файлов завершён":"Codex ищет файлы";
    case "fetch":return failed?"Веб-поиск Codex не выполнен":complete?"Веб-поиск Codex завершён":"Codex выполняет веб-поиск";
    case "other":return failed?"Инструмент Codex завершился с ошибкой":complete?"Инструмент Codex завершён":"Инструмент Codex выполняется";
    default:return failed?"Операция Codex не выполнена":complete?"Операция Codex завершена":"Инструмент Codex выполняется";
  }
}

export class TmaLiveFeed {
  /** A fresh generation on every bot restart; cursors are only valid within it. */
  readonly epoch=randomBytes(12).toString("hex");
  private next=0;
  private readonly recent=new Map<string,LiveEvent[]>();
  private readonly droppedThrough=new Map<string,number>();
  private readonly states=new Map<string,{status:LiveStatus;at:number;label?:string}>();
  private readonly subscribers=new Map<string,Set<(event:LiveEvent)=>void>>();
  private readonly onUpdate=(threadId:string,update:SessionUpdate)=>this.update(threadId,update);
  private readonly onNotification=(method:string,params:unknown)=>this.notification(method,params);
  constructor(private readonly acp:AcpClient){
    acp.on("session-update",this.onUpdate);
    acp.on("notification",this.onNotification);
  }
  dispose(){
    this.acp.off("session-update",this.onUpdate);
    this.acp.off("notification",this.onNotification);
    this.subscribers.clear();this.recent.clear();this.droppedThrough.clear();this.states.clear();
  }
  latestId(){return this.next;}
  hasSubscribers(sessionId:string):boolean{return (this.subscribers.get(sessionId)?.size??0)>0;}
  getStatus(id:string):{status:LiveStatus;at:number;label?:string}|undefined{return this.states.get(id);}
  publish(sessionId:string,event:Omit<LiveEvent,"id"|"sessionId"|"at">){
    if(!sessionId||sessionId.length>128)return;
    const msg:LiveEvent={...event,id:++this.next,sessionId,at:Date.now()};
    const old=this.recent.get(sessionId)??[];
    old.push(msg);
    if(old.length>LIMIT){
      const dropped=old.shift()!;
      this.droppedThrough.set(sessionId,dropped.id);
    }
    this.recent.delete(sessionId);this.recent.set(sessionId,old);
    if(this.recent.size>MAX_THREADS){
      const first=this.recent.keys().next().value;
      if(first&&!this.subscribers.has(first)){
        this.recent.delete(first);
        this.droppedThrough.delete(first);
        this.states.delete(first);
      }
    }
    if(event.kind==="status"&&event.status){
      this.states.set(sessionId,{status:event.status,at:msg.at,label:event.label});
      if(this.states.size>MAX_THREADS)this.states.delete(this.states.keys().next().value!);
    }
    for(const write of this.subscribers.get(sessionId)??[]){
      try{write(msg);}catch{ /* disconnected subscriber */ }
    }
  }
  subscribe(sessionId:string,after:number,write:(message:LiveEvent)=>void):()=>void{
    let handlers=this.subscribers.get(sessionId);
    if(!handlers){handlers=new Set();this.subscribers.set(sessionId,handlers);}
    // Register before replay so events during subscribe are not missed.
    handlers.add(write);
    const dropped=this.droppedThrough.get(sessionId)??0;
    let replayAfter=after;
    if(after>0&&after<dropped){
      write({id:dropped,sessionId,kind:"sync",at:Date.now()});
      replayAfter=dropped;
    }
    for(const event of this.recent.get(sessionId)??[])if(event.id>replayAfter)write(event);
    return ()=>{
      handlers!.delete(write);
      if(handlers!.size===0)this.subscribers.delete(sessionId);
    };
  }
  status(sessionId:string,status:LiveStatus,label?:string){
    this.publish(sessionId,{kind:"status",status,label:str(label,220)});
  }
  private update(id:string,u:SessionUpdate){
    if(u.sessionUpdate==="agent_message_chunk"){
      const text=str(u.content?.text,4000);
      if(text)this.publish(id,{kind:"text",text});
    }else if(u.sessionUpdate==="tool_call"||u.sessionUpdate==="command_execution_started"){
      // Never expose command lines, search queries, tool arguments or full host paths.
      this.publish(id,{kind:"tool",label:u.sessionUpdate==="command_execution_started"?"Команда Codex выполняется":safeToolLabel(u)});
    }else if(u.sessionUpdate==="tool_call_update"){
      // Titles may contain commands, search text, or absolute project paths.
      this.publish(id,{kind:"tool",label:safeToolLabel(u)});
    }
  }
  private notification(method:string,params:unknown){
    const p=params&&typeof params==="object"?params as Record<string,unknown>:{};
    const turn=p.turn&&typeof p.turn==="object"?p.turn as Record<string,unknown>:{};
    const id=str(p.threadId||turn.threadId,128);
    if(!id)return;
    if(method==="item/completed"&&p.item&&typeof p.item==="object"&&
      (p.item as Record<string,unknown>).type==="contextCompaction"){
      this.publish(id,{kind:"compaction",label:"Codex подтвердил сокращение контекста"});
    }else if(method==="thread/status/changed"){
      const status=normalizeThreadStatus(p.status);
      if(status)this.status(id,status.status,status.label);
    }else if(method==="turn/started"){
      this.publish(id,{kind:"plan",turnId:str(turn.id,128),plan:[]});
      this.status(id,"working","Codex выполняет задание");
    }
    else if(method==="turn/plan/updated"){
      const rawPlan=Array.isArray(p.plan)?p.plan.slice(0,30):[];
      const plan=rawPlan.flatMap((raw)=>{
        if(!raw||typeof raw!=="object")return [];
        const value=raw as Record<string,unknown>;
        if(typeof value.step!=="string")return [];
        const step=value.step.slice(0,300).replace(/[\u0000-\u001f\u007f]/g," ").trim();
        if(!step)return [];
        const status:"pending"|"inProgress"|"completed"=value.status==="completed"||value.status==="inProgress"?value.status:"pending";
        return [{step,status}];
      });
      const explanation=typeof p.explanation==="string"
        ?p.explanation.slice(0,1000).replace(/[\u0000-\u001f\u007f]/g," ").trim():"";
      this.publish(id,{kind:"plan",turnId:str(p.turnId,128),explanation,plan});
    }
    else if(method==="turn/completed"){
      const turnStatus=str(turn.status);
      this.status(id,turnStatus==="failed"?"failed":turnStatus==="interrupted"?"cancelled":"completed",
        turnStatus==="failed"?"Задание завершилось с ошибкой":turnStatus==="interrupted"?"Задача остановлена":"Задание завершено");
    }else if(method==="turn/failed"||(method==="error"&&p.willRetry!==true)){
      this.status(id,"failed","Ошибка выполнения");
    }else if(method==="mcpServer/oauth/login/completed"&&typeof p.success==="boolean"){
      const rawName=str(p.name,100).replace(/[\u0000-\u001f\u007f]/g,"").trim();
      const name=rawName||"MCP-сервер";
      this.publish(id,{kind:"activity",label:p.success
        ?`Вход в MCP-сервер ${name} выполнен`
        :`Вход в MCP-сервер ${name} не выполнен`});
    }else if(method==="thread/realtime/transcript/done"&&
      (p.role==="user"||p.role==="assistant")&&typeof p.text==="string"){
      const text=p.text.slice(0,4000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,"").trim();
      if(text)this.publish(id,{kind:"transcript",role:p.role,text});
    }else if(method==="thread/realtime/started"){
      this.publish(id,{kind:"activity",label:"Голосовой режим Codex подключён"});
    }else if(method==="thread/realtime/closed"){
      this.publish(id,{kind:"activity",label:"Голосовой режим Codex завершён"});
    }else if(method==="thread/realtime/error"){
      // Provider error details may contain private request or account data.
      this.publish(id,{kind:"activity",label:"Ошибка голосового соединения Codex"});
    }
  }
}
