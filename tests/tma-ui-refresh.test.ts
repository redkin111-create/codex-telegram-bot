import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Element {
  children:Element[]=[];
  dataset:Record<string,string>={};
  style:Record<string,string>={};
  handlers=new Map<string,(event?:unknown)=>unknown>();
  className="";
  value="";
  textContent="";
  disabled=false;
  hidden=false;
  scrollHeight=0;
  scrollTop=0;
  clientHeight=0;
  src="";
  alt="";
  classList={
    add:(_name:string)=>{},
    remove:(_name:string)=>{},
    toggle:(_name:string,_enabled?:boolean)=>{},
  };
  onclick:(()=>void)|undefined;
  append(...nodes:Element[]){this.children.push(...nodes);}
  appendChild(n:Element){this.children.push(n);}
  replaceChildren(...nodes:Element[]){this.children=[...nodes];}
  addEventListener(type:string,fn:(event?:unknown)=>unknown){this.handlers.set(type,fn);}
  querySelector(_selector:string){return new Element();}
  requestSubmit(){this.handlers.get("submit")?.({preventDefault(){}});}
}

const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,30));

test("TMA manual refresh and automatic history updates work while snapshot is busy",async()=>{
  const ui=readFileSync("apps/mini-app/public/app.js","utf8");
  const elements=new Map<string,Element>();
  function el(id:string){let e=elements.get(id);if(!e){e=new Element();elements.set(id,e);}return e;}
  let answer="First Codex report";
  let waitForSnapshot=false;
  let snapshots=0;
  let finishSnapshot: (()=>void)|undefined;
  const intervals:Array<()=>void>=[];
  const nav=["sessions","chat","queue"].map(tab=>{const b=new Element();b.dataset.tab=tab;return b;});
  const context={
    window:{Telegram:{WebApp:{initData:"signed-real-in-test",ready(){},expand(){}}}},
    document:{
      hidden:false,
      getElementById:el,
      createElement:(_tag:string)=>new Element(),
      querySelectorAll:(_query:string)=>nav,
      addEventListener:()=>{},
      body:new Element(),
    },
    Option:class extends Element {constructor(text:string,value:string){super();this.textContent=text;this.value=value;}},
    AbortController,
    setTimeout,clearTimeout,
    setInterval:(fn:()=>void)=>{intervals.push(fn);return 1;},
    fetch:async (url:string,opts?:{body?:string})=>{
      if(url==="/api/health")return{json:async()=>({online:true})};
      const op=JSON.parse(opts!.body!).op;
      if(op==="snapshot"){
        snapshots++;
        if(waitForSnapshot)await new Promise<void>(resolve=>{finishSnapshot=resolve;});
        return{ok:true,json:async()=>({ok:true,data:{
          projects:[{name:"toy",path:"C:/toy"}],
          sessions:[{id:"session-1",title:"Toy update",cwd:"C:/toy",source:"cli",updatedAt:1}],
          selected:null,
        }})};
      }
      if(op==="history")return{ok:true,json:async()=>({ok:true,data:{
        entries:[{role:"assistant",text:answer,timestamp:Date.now()}],images:[],
      }})};
      if(op==="activity")return{ok:true,json:async()=>({ok:true,data:{
        mtimeMs:Date.now(),size:128,busy:true,queue:0,checkedAt:Date.now(),
      }})};
      if(op==="queue")return{ok:true,json:async()=>({ok:true,data:{items:[],paused:false}})};
      throw new Error("Unexpected operation: "+op);
    },
  };
  runInNewContext(ui,context,{filename:"app.js"});
  await tick();
  assert.equal(intervals.length,4);
  const button=el("session-list").children.find(c=>c.className.includes("session-item"));
  assert(button?.onclick,"session list loaded");
  button.onclick();
  await tick();
  assert.equal(el("messages").children[0]?.children[1]?.textContent,answer);

  // The manual refresh must update the text; no global inFlight lock.
  answer="Second Codex report";
  el("refresh").handlers.get("click")?.();
  await tick();
  assert.equal(el("messages").children[0]?.children[1]?.textContent,"Second Codex report");

  // A stuck catalogue request must not freeze chat history polling.
  waitForSnapshot=true;
  intervals[1]!(); // 30s snapshot poll, artificially blocked
  await tick();
  assert(snapshots>=2);
  answer="Fresh report while snapshot is hung";
  intervals[0]!(); // 5s independent history poll
  await tick();
  assert.equal(el("messages").children[0]?.children[1]?.textContent,answer);
  finishSnapshot?.();
  await tick();
  assert.match(el("activity-meta").textContent,/Codex|активност/);
});
