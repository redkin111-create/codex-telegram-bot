import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Element {
  className="";value="";textContent="";disabled=false;children:Element[]=[];
  dataset:Record<string,string>={};
  style:Record<string,string>={};
  scrollHeight=0;scrollTop=0;clientHeight=0;
  onclick?:()=>void;
  handlers=new Map<string,(event?:any)=>unknown>();
  classList={add(_s:string){},remove(_s:string){},toggle(_s:string,_v?:boolean){}};
  append(...parts:Element[]){this.children.push(...parts);}
  appendChild(element:Element){this.children.push(element);}
  replaceChildren(...parts:Element[]){this.children=[...parts];}
  addEventListener(name:string,callback:(ev?:any)=>unknown){this.handlers.set(name,callback);}
  querySelector(_selector:string){return new Element();}
  requestSubmit(){this.handlers.get("submit")?.({preventDefault(){}});}
}
const pause=(ms=25)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test("TMA survives health timeout, distinguishes Codex crash from PC offline and catches up on foreground return",async()=>{
  const dom=new Map<string,Element>(),callbacks=new Map<string,()=>void>(),intervals:Array<()=>void>=[];
  const element=(id:string)=>{
    if(!dom.has(id))dom.set(id,new Element());
    return dom.get(id)!;
  };
  const tabButtons=["sessions","chat","queue"].map(tab=>{const node=new Element();node.dataset.tab=tab;return node;});
  const document={
    hidden:false,
    getElementById:element,
    createElement:()=>new Element(),
    querySelectorAll:()=>tabButtons,
    addEventListener:(name:string,fn:()=>void)=>{callbacks.set(name,fn);},
    body:new Element(),
  };
  const windowCallbacks=new Map<string,()=>void>();
  const window={
    Telegram:{WebApp:{initData:"signed-test-payload",ready(){},expand(){}}},
    addEventListener:(name:string,fn:()=>void)=>{windowCallbacks.set(name,fn);},
  };
  let connected=false,down=false,message="Старый отчёт";
  const fetch=async (url:string,options?:{body?:string;signal?:AbortSignal})=>{
    if(url==="/api/health"){
      if(down){
        return new Promise<never>((_resolve,reject)=>{
          options?.signal?.addEventListener("abort",()=>reject(new Error("timeout")),{once:true});
        });
      }
      return {ok:true,json:async()=>({online:true,codexConnected:connected})};
    }
    const op=JSON.parse(options?.body??"{}").op;
    if(op==="snapshot")return{ok:true,json:async()=>({ok:true,data:{
      projects:[{name:"toy",path:"C:/toy"}],
      sessions:[{id:"thread-0001",title:"TMA reliability",cwd:"C:/toy",source:"cli",updatedAt:1}],
      selected:"thread-0001",
    }})};
    if(op==="history")return{ok:true,json:async()=>({ok:true,data:{
      entries:[{role:"assistant",text:message}],images:[],
    }})};
    if(op==="activity")return{ok:true,json:async()=>({ok:true,data:{
      mtimeMs:Date.now(),size:100,busy:false,queue:0,checkedAt:Date.now(),
    }})};
    if(op==="queue")return{ok:true,json:async()=>({ok:true,data:{items:[],paused:false}})};
    throw Error("Unexpected TMA operation "+op);
  };
  const fastTimeout=(fn:()=>void,ms:number)=>setTimeout(fn,ms===6000?5:ms);
  runInNewContext(readFileSync("apps/mini-app/public/app.js","utf8"),{
    window,document,
    AbortController,
    fetch,
    setTimeout:fastTimeout,
    clearTimeout,
    setInterval:(fn:()=>void)=>{intervals.push(fn);return 1;},
    Option:class extends Element {constructor(text:string,value:string){super();this.textContent=text;this.value=value;}},
  },{filename:"app.js"});

  await pause();
  assert.equal(intervals.length,4);
  assert.match(element("chat-state").textContent,/Codex app-server переподключается/);
  assert.equal(element("prompt").disabled,true);

  // Native Codex reconnects but the existing catalogue need not be refreshed.
  connected=true;
  intervals[3]!();
  await pause();
  assert.equal(element("prompt").disabled,false);

  // Telegram's background webview may lose the TCP session; stop after two
  // failed bounded health probes, recover automatically with no manual refresh.
  down=true;
  intervals[3]!();
  await pause();
  intervals[3]!();
  await pause();
  assert.match(element("chat-state").textContent,/Нет связи с ноутбуком/);
  down=false;
  intervals[3]!();
  await pause();
  assert.equal(element("prompt").disabled,false);

  document.hidden=true;
  callbacks.get("visibilitychange")?.();
  message="Новый полный отчёт после сна телефона";
  document.hidden=false;
  callbacks.get("visibilitychange")?.();
  await pause(50);
  assert.equal(element("messages").children.at(-1)?.children[1]?.textContent,message);
});
