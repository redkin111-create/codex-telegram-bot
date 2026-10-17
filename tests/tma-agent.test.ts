import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReasoningEffort } from "../src/app/types.js";
import { MiniAppAgent } from "../src/tma/agent.js";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

test("mobile-only agent can use existing runtime logic without an outbound TMA transport",()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-agent-"));
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp:new EventEmitter() as AcpClient,registry:{} as RuntimeRegistry});
  try{assert.throws(()=>agent.start(),/gateway/i);}
  finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("Windows Mini App agent lists existing Codex projects and sessions",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-tma-agent-"));
  const project=join(dir,"toy");
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"toy",roots:[project],createdAt:1,updatedAt:1,recencyAt:1}],
    listThreads:async()=>[{id:"session-a",name:"Yupland NFT work",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2}],
    availableModels:[{modelId:"test",name:"Test Model"}],
    currentModelId:"test",
  }) as unknown as AcpClient;
  const runtime={sessionId:"session-a",queueLength:0,isBusy:false};
  const controller={
    list:()=>[{sessionId:"session-a",cwd:project,projectName:"toy",busy:false,foreground:true,unread:0,queueLength:0,queuePaused:false,canClose:true}],
    runtimeForSession:()=>runtime,
    foreground:()=>runtime,
    addAttach:async()=>{throw new Error("should not attach for snapshot");},
  };
  const registry={controller:()=>controller,get:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301","secret-with-more-than-thirty-two-characters");
  try{
    const result=await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}}) as {
      projects:Array<{name:string;path:string}>;sessions:Array<{id:string;title:string}>;
      selected:string;online:boolean;
    };
    assert.equal(result.projects[0]?.name,"toy");
    assert.equal(result.projects[0]?.path,project);
    assert.equal(result.sessions[0]?.id,"session-a");
    assert.equal(result.selected,"session-a");
    assert.equal(result.online,true);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile capability inventory is redacted and settings reuse the owner's existing session runtime",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-capabilities-"));
  const sessionId="10101010-1010-4010-8010-101010101010";
  let inventoryRefreshes=0;
  const runtime={
    sessionId,model:"fixture-model",agent:"code",reasoning:"medium" as ReasoningEffort,
    async setModelPref(value:string){this.model=value;return {ok:true};},
    async setAgentPref(value:string){this.agent=value;return {ok:true};},
    setReasoningPref(value:ReasoningEffort){this.reasoning=value;},
  };
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"toy",roots:[dir]}],
    listThreads:async()=>[{id:sessionId,name:"Mobile settings",cwd:dir,source:"cli",recencyAt:2}],
    refreshInventories:async()=>{inventoryRefreshes++;},
    accountState:async()=>({account:{type:"chatgpt",email:"owner@example.invalid",planType:"Plus"},
      rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:123}}}),
    availableModels:[{modelId:"fixture-model",name:"Fixture model",description:"Model description"}],
    availableModes:[{id:"code",name:"Code",description:"Code mode"}],
    currentModelId:"fixture-model",currentModeId:"code",
    availableSkills:[{name:"fixture-skill",description:"Safe text",path:"C:\\private\\skill\\SKILL.md",enabled:true}],
    availableMcpServers:[{name:"fixture-mcp",tools:{run:{token:"must not escape"}}}],
    currentSubagents:()=>[
      {sessionId:"own-agent",agentName:"Own agent",status:{type:"running"}},
      {sessionId:"other-agent",agentName:"Other agent",status:{type:"running"}},
    ],
    hasModel:(id:string)=>id==="fixture-model",
    hasMode:(id:string)=>id==="code",
  }) as unknown as AcpClient;
  Object.defineProperty(acp,"isConnected",{value:true});
  const registry={
    controller:()=>({list:()=>[]}),
    get:()=>runtime,
    runtimeForSession:()=>runtime,
    ownerChatForSession:(id:string)=>id==="own-agent"?101:202,
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const capabilities=await agent.executeMobile({op:"capabilities",userId:101,args:{sessionId}}) as {
      skills:Array<{name:string}>;mcpServers:Array<{toolCount:number}>;subagents:Array<{id:string}>;limits:Array<{primary?:{usedPercent:number}}>;
    };
    assert.equal(inventoryRefreshes,1);
    assert.equal(capabilities.skills[0]?.name,"fixture-skill");
    assert.equal(capabilities.mcpServers[0]?.toolCount,1);
    assert.deepEqual(capabilities.subagents.map((entry)=>entry.id),["own-agent"]);
    assert.equal(capabilities.limits[0]?.primary?.usedPercent,12);
    assert.doesNotMatch(JSON.stringify(capabilities),/C:\\\\private|must not escape/);
    await agent.executeMobile({op:"setModel",userId:101,args:{sessionId,modelId:"fixture-model"}});
    await agent.executeMobile({op:"setMode",userId:101,args:{sessionId,modeId:"code"}});
    await agent.executeMobile({op:"setReasoning",userId:101,args:{sessionId,effort:"high"}});
    assert.equal(runtime.model,"fixture-model");
    assert.equal(runtime.agent,"code");
    assert.equal(runtime.reasoning,"high");
    await assert.rejects(agent.executeMobile({op:"setReasoning",userId:101,args:{sessionId,effort:"unsafe"}}),/Недопустимый уровень/);
    await assert.rejects(agent.executeMobile({op:"capabilities",userId:202,args:{}}),/Пользователь не разрешён/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile plugin and app catalogs redact host data and plugin changes stay owner-scoped",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-integrations-"));
  const sessionId="20202020-2020-4020-8020-202020202020";
  const calls:Array<{op:string;id?:string;marketplace?:string;cwd?:string}> = [];
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async()=>[{id:sessionId,name:"Plugin session",cwd:dir,source:"cli",recencyAt:2}],
    refreshInventories:async()=>undefined,
    accountState:async()=>({}),
    currentSubagents:()=>[],
    availableModels:[],
    availableModes:[],
    availableSkills:[],
    availableMcpServers:[],
    currentModelId:"default",
    mobileIntegrationInventory:async(cwd?:string,threadId?:string)=>{
      calls.push({op:"inventory",cwd,id:threadId});
      return {
        pluginCatalog:{marketplaces:[{name:"official",path:"C:\\private\\marketplace.json",plugins:[
          {id:"reviewer@official",name:"reviewer",installed:false,enabled:true,installPolicy:"AVAILABLE",availability:"AVAILABLE",source:{type:"remote"},interface:{shortDescription:"Review project changes"}},
        ]}]},installedPlugins:{marketplaces:[]},
        apps:{data:[{id:"calendar",name:"Calendar",description:"Schedule connector",isEnabled:true,isAccessible:false,installUrl:"javascript:alert(1)"}]},
        installedApps:{apps:[]},
      };
    },
    async installMobilePlugin(id:string,marketplace:string,cwd:string){calls.push({op:"install",id,marketplace,cwd});return {appsNeedingAuth:[
      {id:"calendar",name:"Calendar",installUrl:"https://login.example.invalid/connect"},
      {id:"unsafe",name:"Unsafe",installUrl:"javascript:alert(1)"},
    ]};},
    async uninstallMobilePlugin(id:string){calls.push({op:"uninstall",id});},
  }) as unknown as AcpClient;
  const registry={
    controller:()=>({list:()=>[]}),
    get:()=>runtime,
    runtimeForSession:()=>runtime,
    ownerChatForSession:()=>101,
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const capabilities=await agent.executeMobile({op:"capabilities",userId:101,args:{sessionId}}) as {
      plugins:Array<{id:string;installable:boolean}>;apps:Array<{id:string;installUrl?:string}>;pluginCatalogAvailable:boolean;
    };
    assert.equal(capabilities.pluginCatalogAvailable,true);
    assert.equal(capabilities.plugins[0]?.installable,true);
    assert.equal(capabilities.apps[0]?.installUrl,undefined);
    assert.doesNotMatch(JSON.stringify(capabilities),/C:\\\\private/);
    assert.deepEqual(calls[0],{op:"inventory",cwd:dir,id:sessionId});
    const installed=await agent.executeMobile({op:"installPlugin",userId:101,args:{sessionId,pluginId:"reviewer@official",marketplace:"official"}}) as {
      installed:boolean;authorizationRequired:Array<{name:string;installUrl?:string}>;
    };
    assert.equal(installed.installed,true);
    assert.deepEqual(installed.authorizationRequired,[
      {id:"calendar",name:"Calendar",installUrl:"https://login.example.invalid/connect"},
      {id:"unsafe",name:"Unsafe"},
    ]);
    assert.deepEqual(calls[1],{op:"install",id:"reviewer@official",marketplace:"official",cwd:dir});
    await agent.executeMobile({op:"uninstallPlugin",userId:101,args:{sessionId,pluginId:"reviewer@official"}});
    assert.equal(calls[2]?.op,"uninstall");
    await assert.rejects(agent.executeMobile({op:"installPlugin",userId:202,args:{sessionId,pluginId:"reviewer@official",marketplace:"official"}}),/не разрешён/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile session archive, restore and rename reuse the owner's Codex catalogue",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-sessions-"));
  const activeId="30303030-3030-4030-8030-303030303030";
  const archivedId="40404040-4040-4040-8040-404040404040";
  const busyId="50505050-5050-4050-8050-505050505050";
  const active={id:activeId,name:"Active session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const busyThread={id:busyId,name:"Busy session",cwd:dir,source:"cli",createdAt:1,updatedAt:1,recencyAt:1};
  const archived={id:archivedId,name:"Archived session",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1};
  const calls:Array<{op:string;id:string;name?:string}> = [];
  let busy=false;
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[archived]:[active,busyThread],
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[archived]:[active,busyThread],
    archiveThread:async(id:string)=>{calls.push({op:"archive",id});},
    unarchiveThread:async(id:string)=>{calls.push({op:"unarchive",id});},
    setThreadName:async(id:string,name:string)=>{calls.push({op:"rename",id,name});},
  }) as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===activeId||id===busyId?{sessionId:id,isBusy:busy}:undefined,
    ownerChatForSession:()=>undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  const perform=(op:string,args:Record<string,unknown>)=>agent.executeMobile({op,userId:101,args} as never);
  try{
    assert.equal(await agent.canReadSession(archivedId,101),true,"archived history remains readable to its owner");
    assert.equal(await agent.canReadSession(archivedId,202),false,"an unapproved user cannot read an archived thread");

    await perform("renameThread",{sessionId:activeId,name:"Renamed from phone"});
    assert.deepEqual(calls.at(-1),{op:"rename",id:activeId,name:"Renamed from phone"});
    await assert.rejects(perform("renameThread",{sessionId:activeId,name:"  "}),/название|имя/i);

    await perform("archiveThread",{sessionId:activeId});
    assert.deepEqual(calls.at(-1),{op:"archive",id:activeId});
    await perform("unarchiveThread",{sessionId:archivedId});
    assert.deepEqual(calls.at(-1),{op:"unarchive",id:archivedId});

    busy=true;
    await assert.rejects(perform("archiveThread",{sessionId:busyId}),/занят|выполня/i);
    await assert.rejects(agent.executeMobile({op:"archiveThread",userId:202,args:{sessionId:activeId}} as never),/не разрешён|доступ/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile steer reuses the active owner runtime and never sends without a confirmed active turn",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-steer-"));
  const sessionId="60606060-6060-4060-8060-606060606060";
  const thread={id:sessionId,name:"Steerable session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const runtime={sessionId,isBusy:true};
  let active=true;
  const calls:Array<{id:string;content:unknown}> = [];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[thread],
    canSteer:(id:string)=>id===sessionId&&active,
    steer:async(id:string,content:unknown[])=>{calls.push({id,content});},
  }) as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===sessionId?runtime:undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  const args=(requestId:string,text:string)=>({sessionId,requestId,text});
  try{
    const result=await agent.executeMobile({op:"steer",userId:101,args:args("steer-request-0001","Остановись после проверки теста")});
    assert.deepEqual(result,{steered:true});
    assert.deepEqual(calls,[{id:sessionId,content:[{type:"text",text:"Остановись после проверки теста"}]}]);
    await assert.rejects(agent.executeMobile({op:"steer",userId:101,args:args("steer-request-0001","другой текст")}),/ID.*другого направления/i);
    runtime.isBusy=false;
    await assert.rejects(agent.executeMobile({op:"steer",userId:101,args:args("steer-request-0002","Не отправлять")}),/активного хода/i);
    runtime.isBusy=true;
    active=false;
    await assert.rejects(agent.executeMobile({op:"steer",userId:202,args:args("steer-request-0003","Чужой owner")}),/не разрешён/i);
    assert.equal(calls.length,1);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile fork copies an authorized idle thread and persists the new owner",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-fork-"));
  const sourceId="70707070-7070-4070-8070-707070707070";
  const forkId="80808080-8080-4080-8080-808080808080";
  const source={id:sourceId,name:"Source session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const forked={thread:{id:forkId,name:"Source session · ответвление",source:"appServer"},cwd:dir,model:"fixture-model"};
  const threads=[source];
  let busy=false;
  let activeTurn=false;
  const calls:string[]=[];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    hasActiveTurn:(id:string)=>id===sourceId&&activeTurn,
    forkThread:async(id:string)=>{calls.push(id);threads.unshift({...source,id:forkId,name:forked.thread.name,source:"appServer"});return forked;},
  }) as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===sourceId?{sessionId:id,isBusy:busy}:undefined,
    ownerChatForSession:()=>undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    assert.equal(await agent.canReadSession(sourceId,101),true);
    const result=await agent.executeMobile({op:"forkThread",userId:101,args:{sessionId:sourceId}} as never) as {sessionId?:string};
    assert.equal(result.sessionId,forkId);
    assert.deepEqual(calls,[sourceId]);
    assert.equal(await agent.canReadSession(forkId,101),true);
    assert.equal(await agent.canReadSession(forkId,202),false);
    const restoredAgent=new MiniAppAgent({cfg,acp,registry});
    try{
      assert.equal(await restoredAgent.canReadSession(forkId,101),true,"the owner can reopen their fork after the mobile adapter is recreated");
      assert.equal(await restoredAgent.canReadSession(forkId,202),false,"another allowed account cannot read the persisted mobile fork");
    }finally{restoredAgent.stop();}
    busy=true;
    await assert.rejects(agent.executeMobile({op:"forkThread",userId:101,args:{sessionId:sourceId}} as never),/выполня|активный ход/i);
    busy=false;
    activeTurn=true;
    await assert.rejects(agent.executeMobile({op:"forkThread",userId:101,args:{sessionId:sourceId}} as never),/выполня|активный ход/i);
    assert.deepEqual(calls,[sourceId]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile goal controls read, update and clear only through the authorized thread",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-goal-"));
  const sessionId="90909090-9090-4090-8090-909090909090";
  const thread={id:sessionId,name:"Goal session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  let goal:{threadId:string;objective:string;status:"active"|"paused";tokenBudget:number|null;tokensUsed:number;timeUsedSeconds:number;createdAt:number;updatedAt:number}|undefined={
    threadId:sessionId,objective:"Run existing checks",status:"active",tokenBudget:12000,tokensUsed:140,timeUsedSeconds:45,createdAt:1,updatedAt:2,
  };
  const calls:Array<{op:string;threadId:string;input?:unknown}> = [];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async()=>[thread],
    refreshInventories:async()=>{},
    accountState:async()=>({}),
    getThreadGoal:async(id:string)=>{calls.push({op:"get",threadId:id});return goal;},
    setThreadGoal:async(id:string,input:Record<string,unknown>)=>{calls.push({op:"set",threadId:id,input});goal={...goal!,...input,threadId:id,status:(input.status as "active"|"paused")??goal!.status,tokenBudget:(input.tokenBudget as number|null|undefined)??goal!.tokenBudget};return goal;},
    clearThreadGoal:async(id:string)=>{calls.push({op:"clear",threadId:id});goal=undefined;return {cleared:true};},
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],currentSubagents:()=>[],
  }) as unknown as AcpClient;
  Object.defineProperty(acp,"isConnected",{value:true});
  const registry={runtimeForSession:()=>undefined,ownerChatForSession:()=>undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const capabilities=await agent.executeMobile({op:"capabilities",userId:101,args:{sessionId}} as never) as {goalAvailable:boolean;goal?:{objective:string}};
    assert.equal(capabilities.goalAvailable,true);
    assert.equal(capabilities.goal?.objective,"Run existing checks");
    await agent.executeMobile({op:"setGoal",userId:101,args:{sessionId,objective:"Review changes",tokenBudget:8000,status:"paused"}} as never);
    assert.deepEqual(calls.at(-1),{op:"set",threadId:sessionId,input:{objective:"Review changes",status:"paused",tokenBudget:8000}});
    await agent.executeMobile({op:"clearGoal",userId:101,args:{sessionId}} as never);
    assert.deepEqual(calls.at(-1),{op:"clear",threadId:sessionId});
    await assert.rejects(agent.executeMobile({op:"setGoal",userId:202,args:{sessionId,objective:"Forbidden"}} as never),/не разрешён/i);
    await assert.rejects(agent.executeMobile({op:"setGoal",userId:101,args:{sessionId,tokenBudget:-1}} as never),/бюджет/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile context compaction reuses the owner runtime and refuses active turns",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-compact-"));
  const sessionId="91919191-9191-4191-8191-919191919191";
  const thread={id:sessionId,name:"Compact session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const runtime={sessionId,isBusy:false};
  let activeTurn=false;
  const calls:string[]=[];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async()=>[thread],
    hasActiveTurn:()=>activeTurn,
    compactThread:async(id:string)=>{calls.push(id);},
  }) as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===sessionId?runtime:undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    assert.deepEqual(await agent.executeMobile({op:"compactThread",userId:101,args:{sessionId}} as never),{started:true});
    assert.deepEqual(calls,[sessionId]);
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"compactThread",userId:101,args:{sessionId}} as never),/выполняет задачу/i);
    runtime.isBusy=false;
    activeTurn=true;
    await assert.rejects(agent.executeMobile({op:"compactThread",userId:101,args:{sessionId}} as never),/активн|выполняет/i);
    await assert.rejects(agent.executeMobile({op:"compactThread",userId:202,args:{sessionId}} as never),/не разрешён/i);
    assert.deepEqual(calls,[sessionId]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile project files stay inside the authorized session, hide secrets and save with a stale-file check",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-files-"));
  const project=join(dir,"project");
  mkdirSync(join(project,"src"),{recursive:true});
  writeFileSync(join(project,"src","main.ts"),"export const answer = 42;\n");
  writeFileSync(join(project,".env"),"API_KEY=do-not-expose\n");
  const sessionId="20202020-2020-4020-8020-202020202020";
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Mobile file edit",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const root=await agent.executeMobile({op:"files",userId:101,args:{sessionId}}) as {entries:Array<{name:string}>};
    assert.deepEqual(root.entries.map((entry)=>entry.name),["src"]);
    const listing=await agent.executeMobile({op:"files",userId:101,args:{sessionId,path:"src"}}) as {entries:Array<{name:string;kind:string}>};
    assert.deepEqual(listing.entries.map((entry)=>entry.name),["main.ts"]);
    const file=await agent.executeMobile({op:"readFile",userId:101,args:{sessionId,path:"src/main.ts"}}) as {text:string;sha256:string};
    assert.equal(file.text,"export const answer = 42;\n");
    const created=await agent.executeMobile({op:"createFile",userId:101,args:{sessionId,path:"src/new.ts",content:""}}) as {sha256:string};
    assert.equal(created.sha256,createHash("sha256").update("").digest("hex"));
    assert.equal((await agent.executeMobile({op:"readFile",userId:101,args:{sessionId,path:"src/new.ts"}}) as {text:string}).text,"");
    await assert.rejects(agent.executeMobile({op:"createFile",userId:101,args:{sessionId,path:"src/main.ts",content:"overwrite"}}),/already exists|существует/i);
    await assert.rejects(agent.executeMobile({op:"createFile",userId:101,args:{sessionId,path:"src/.env",content:"secret"}}),/недоступен|Недопустимый/);
    await assert.rejects(agent.executeMobile({op:"readFile",userId:101,args:{sessionId,path:"../.env"}}),/относительный|Недопустимый путь|недоступен/);
    await assert.rejects(agent.executeMobile({op:"readFile",userId:101,args:{sessionId,path:".env"}}),/недоступен/);
    const result=await agent.executeMobile({op:"writeFile",userId:101,args:{sessionId,path:"src/main.ts",content:"export const answer = 43;\n",expectedHash:file.sha256}}) as {sha256:string};
    assert.notEqual(result.sha256,file.sha256);
    await assert.rejects(agent.executeMobile({op:"writeFile",userId:101,args:{sessionId,path:"src/main.ts",content:"stale",expectedHash:file.sha256}}),/изменился/);
    runtime.isBusy=true;
    const updated=await agent.executeMobile({op:"readFile",userId:101,args:{sessionId,path:"src/main.ts"}}) as {sha256:string};
    await assert.rejects(agent.executeMobile({op:"writeFile",userId:101,args:{sessionId,path:"src/main.ts",content:"during turn",expectedHash:updated.sha256}}),/текущей задачи/);
    await assert.rejects(agent.executeMobile({op:"createFile",userId:101,args:{sessionId,path:"src/busy.ts",content:"x"}}),/текущей задачи/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile Git view reads bounded branch status and safe staged and unstaged diffs",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-git-"));
  const project=join(dir,"repo");
  mkdirSync(project,{recursive:true});
  const run=(...args:string[])=>execFileSync("git",["-C",project,...args],{stdio:"ignore",windowsHide:true});
  run("init","-q");
  run("config","user.name","Codex Mobile Test");
  run("config","user.email","codex-mobile-test@example.invalid");
  writeFileSync(join(project,"main.ts"),"export const answer = 1;\n");
  writeFileSync(join(project,"move.me"),"rename fixture\n");
  run("add","main.ts");
  run("add","move.me");
  run("commit","-m","fixture base");
  run("mv","move.me","renamed résumé.md");
  writeFileSync(join(project,"main.ts"),"export const answer = 2;\n");
  run("add","main.ts");
  writeFileSync(join(project,"main.ts"),"export const answer = 3;\n");
  writeFileSync(join(project,"notes.txt"),"untracked note\n");
  writeFileSync(join(project,"résumé file.txt"),"unicode path\n");
  const sessionId="30303030-3030-4030-8030-303030303030";
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Git fixture",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const status=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {
      branch:string;clean:boolean;changes:Array<{code:string;path:string;previousPath?:string}>;
    };
    assert.ok(status.branch);
    assert.equal(status.clean,false);
    assert.ok(status.changes.some((entry)=>entry.code==="MM"&&entry.path.includes("main.ts")));
    assert.ok(status.changes.some((entry)=>entry.code==="??"&&entry.path.includes("notes.txt")));
    assert.ok(status.changes.some((entry)=>entry.path==="résumé file.txt"));
    assert.ok(status.changes.some((entry)=>entry.code.startsWith("R")&&entry.path==="renamed résumé.md"&&entry.previousPath==="move.me"),JSON.stringify(status.changes));
    const diff=await agent.executeMobile({op:"gitDiff",userId:101,args:{sessionId}}) as {staged:string;unstaged:string};
    assert.match(diff.staged,/answer = 2/);
    assert.match(diff.unstaged,/answer = 3/);
    assert.doesNotMatch(diff.unstaged,/--color/);
    const mainDiff=await agent.executeMobile({op:"gitDiff",userId:101,args:{sessionId,path:"main.ts"}}) as {staged:string;unstaged:string};
    assert.match(mainDiff.unstaged,/answer = 3/);
    assert.doesNotMatch(mainDiff.staged,/rename from move\.me/);
    await assert.rejects(agent.executeMobile({op:"gitDiff",userId:101,args:{sessionId,path:"..\\outside.txt"}}),/Недопустимый путь Git/);
    const renameDiff=await agent.executeMobile({op:"gitDiff",userId:101,args:{sessionId,path:"renamed résumé.md",previousPath:"move.me"}}) as {staged:string;unstaged:string};
    assert.match(renameDiff.staged,/rename from move\.me/);
    assert.doesNotMatch(renameDiff.staged,/diff --git a\/main\.ts/);
    await agent.executeMobile({op:"gitUnstage",userId:101,args:{sessionId,path:"renamed résumé.md",previousPath:"move.me"}});
    let renameUnstaged=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {changes:Array<{code:string;path:string}>};
    assert.ok(renameUnstaged.changes.some((entry)=>entry.code==="D"&&entry.path==="move.me"));
    assert.ok(renameUnstaged.changes.some((entry)=>entry.code==="??"&&entry.path==="renamed résumé.md"));
    await agent.executeMobile({op:"gitStage",userId:101,args:{sessionId,path:"move.me"}});
    await agent.executeMobile({op:"gitStage",userId:101,args:{sessionId,path:"renamed résumé.md"}});
    const renameRestaged=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {changes:Array<{code:string;path:string;previousPath?:string}>};
    assert.ok(renameRestaged.changes.some((entry)=>entry.code.startsWith("R")&&entry.path==="renamed résumé.md"&&entry.previousPath==="move.me"));
    await agent.executeMobile({op:"gitStage",userId:101,args:{sessionId,path:"notes.txt"}});
    let afterStage=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {changes:Array<{path:string;indexStatus:string;worktreeStatus:string}>};
    assert.ok(afterStage.changes.some((entry)=>entry.path.includes("notes.txt")&&entry.indexStatus==="A"&&entry.worktreeStatus===" "));
    await agent.executeMobile({op:"gitUnstage",userId:101,args:{sessionId,path:"notes.txt"}});
    let afterUnstage=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {changes:Array<{path:string;code:string}>};
    assert.ok(afterUnstage.changes.some((entry)=>entry.path.includes("notes.txt")&&entry.code==="??"));
    await agent.executeMobile({op:"gitStage",userId:101,args:{sessionId,path:"notes.txt"}});
    const commit=await agent.executeMobile({op:"gitCommit",userId:101,args:{sessionId,message:"mobile fixture commit"}}) as {message:string;commit:string};
    assert.equal(commit.message,"mobile fixture commit");
    assert.ok(commit.commit.length>=7);
    assert.equal(execFileSync("git",["-C",project,"log","-1","--pretty=%s"],{encoding:"utf8",windowsHide:true}).trim(),"mobile fixture commit");
    await assert.rejects(agent.executeMobile({op:"gitCreateBranch",userId:101,args:{sessionId,name:"bad branch"}}),/not a valid branch name/i);
    const branch=await agent.executeMobile({op:"gitCreateBranch",userId:101,args:{sessionId,name:"phone-flow"}}) as {branch:string};
    assert.equal(branch.branch,"phone-flow");
    assert.equal(execFileSync("git",["-C",project,"branch","--show-current"],{encoding:"utf8",windowsHide:true}).trim(),"phone-flow");
    execFileSync("git",["-C",project,"branch","release/candidate"],{windowsHide:true});
    const branchStatus=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {branches:string[]};
    assert.ok(branchStatus.branches.includes("release/candidate"));
    const switched=await agent.executeMobile({op:"gitSwitchBranch",userId:101,args:{sessionId,name:"release/candidate"}}) as {branch:string};
    assert.equal(switched.branch,"release/candidate");
    assert.equal(execFileSync("git",["-C",project,"branch","--show-current"],{encoding:"utf8",windowsHide:true}).trim(),"release/candidate");
    await assert.rejects(agent.executeMobile({op:"gitSwitchBranch",userId:101,args:{sessionId,name:"missing"}}),/Не удалось найти ветку/i);
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"gitStage",userId:101,args:{sessionId,path:"main.ts"}}),/текущей задачи/);
    await assert.rejects(agent.executeMobile({op:"gitSwitchBranch",userId:101,args:{sessionId,name:"phone-flow"}}),/текущей задачи/);
    await assert.rejects(agent.executeMobile({op:"gitStage",userId:202,args:{sessionId,path:"main.ts"}}),/Пользователь не разрешён на ПК/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("TMA can still send to a listed session omitted by a later catalogue refresh",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-tma-stale-session-"));
  const sessionId="01234567-89ab-7cde-8123-456789abcdef";
  const originalNow=Date.now;
  let now=originalNow();
  let listed=true;
  let submits=0;
  Date.now=()=>now;
  try{
    const acp=Object.assign(new EventEmitter(),{
      listProjects:async()=>[{id:"p1",name:"toy",roots:[dir]}],
      listThreads:async()=>listed?[{id:sessionId,name:"Open TMA session",cwd:dir,source:"cli",recencyAt:2}]:[],
      availableModels:[{modelId:"test",name:"Test Model"}],
      currentModelId:"test",
    }) as unknown as AcpClient;
    const runtime={sessionId,queueLength:0,isBusy:false};
    const controller={
      list:()=>[],
      runtimeForSession:()=>runtime,
      foreground:()=>runtime,
    };
    const registry={
      controller:()=>controller,
      get:()=>runtime,
      submitPrompt:async()=>{submits++;return {kind:"submitted",outcome:"accepted"};},
    } as unknown as RuntimeRegistry;
    const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],
      allowedUsers:new Set(["101"])} as AppConfig;
    const agent=new MiniAppAgent({cfg,acp,registry},"http://127.0.0.1:3301",
      "secret-with-more-than-thirty-two-characters");
    try{
      await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
      listed=false;
      now+=12_001;
      await agent.execute({id:"abcdef0123456789abcdef02",op:"snapshot",userId:101,args:{}});
      const result=await agent.execute({id:"abcdef0123456789abcdef03",op:"send",userId:101,
        args:{sessionId,text:"Проверка TMA",images:[],requestId:"client_0123456789abcdef"}});
      assert.deepEqual(result,{result:"accepted"});
      assert.equal(submits,1);
    }finally{agent.stop();}
  }finally{
    Date.now=originalNow;
    rmSync(dir,{recursive:true,force:true});
  }
});
