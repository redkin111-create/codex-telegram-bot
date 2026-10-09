/** Bounded per-session live event feed for Codex Mini App.
 *
 * Events contain only user-facing deltas and tool labels, never raw commands,
 * environment variables, internal RPC params, or file contents.
 * Subscriber authorization is performed by the gateway before connecting.
 */
import type { AcpClient } from "../acp/client.js";
import type { SessionUpdate } from "../acp/types.js";

export type LiveStatus="working"|"approval"|"completed"|"failed"|"cancelled"|"observing";
export interface LiveEvent {
  id:number;
  sessionId:string;
  kind:"text"|"tool"|"status"|"activity";
  text?:string;
  label?:string;
  status?:LiveStatus;
  at:number;
}
const LIMIT=160;
const MAX_THREADS=200;
const str=(v:unknown,max=250)=>typeof v==="string"?v.slice(0,max):"";

export class TmaLiveFeed {
  private next=0;
  private readonly recent=new Map<string,LiveEvent[]>();
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
    this.subscribers.clear();this.recent.clear();this.states.clear();
  }
  latestId(){return this.next;}
  getStatus(id:string):{status:LiveStatus;at:number;label?:string}|undefined{return this.states.get(id);}
  publish(sessionId:string,event:Omit<LiveEvent,"id"|"sessionId"|"at">){
    if(!sessionId||sessionId.length>128)return;
    const msg:LiveEvent={...event,id:++this.next,sessionId,at:Date.now()};
    const old=this.recent.get(sessionId)??[];
    old.push(msg);
    if(old.length>LIMIT)old.shift();
    this.recent.delete(sessionId);this.recent.set(sessionId,old);
    if(this.recent.size>MAX_THREADS){
      const first=this.recent.keys().next().value;
      if(first&&!this.subscribers.has(first))this.recent.delete(first);
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
    for(const event of this.recent.get(sessionId)??[])if(event.id>after)write(event);
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
      // Generic label only. Never send tool-call input/arguments to browser.
      this.publish(id,{kind:"tool",label:str(u.title||u.kind||"Запущен инструмент")});
    }else if(u.sessionUpdate==="tool_call_update"){
      this.publish(id,{kind:"tool",label:str(u.title||u.kind||"Инструмент завершён")});
    }
  }
  private notification(method:string,params:unknown){
    const p=params&&typeof params==="object"?params as Record<string,unknown>:{};
    const turn=p.turn&&typeof p.turn==="object"?p.turn as Record<string,unknown>:{};
    const id=str(p.threadId||turn.threadId,128);
    if(!id)return;
    if(method==="turn/started")this.status(id,"working","Codex выполняет задание");
    else if(method==="turn/completed"){
      const turnStatus=str(turn.status);
      this.status(id,turnStatus==="failed"?"failed":turnStatus==="interrupted"?"cancelled":"completed",
        turnStatus==="failed"?"Задание завершилось с ошибкой":turnStatus==="interrupted"?"Задача остановлена":"Задание завершено");
    }else if(method==="turn/failed"||(method==="error"&&p.willRetry!==true)){
      this.status(id,"failed","Ошибка выполнения");
    }
  }
}
