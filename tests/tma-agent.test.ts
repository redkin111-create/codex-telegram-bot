import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReasoningEffort } from "../src/app/types.js";
import { MiniAppAgent, type MobilePtyFactory, type MobilePtyOptions, type MobilePtyProcess } from "../src/tma/agent.js";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import { CODEX_PINNED_THREAD_SECTION_ID } from "../src/acp/codex-protocol.js";
import { TelegramSessionRegistry } from "../src/sessions/telegram-registry.js";
import { saveIncomingAttachment } from "../src/bot/incoming-files.js";

test("mobile-only agent can use existing runtime logic without an outbound TMA transport",()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-agent-"));
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp:new EventEmitter() as AcpClient,registry:{} as RuntimeRegistry});
  try{assert.throws(()=>agent.start(),/gateway/i);}
  finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile background process controls are limited to an owned thread and a process returned for that thread",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-background-terminals-"));
  const sessionId="96969696-9696-4969-8969-969696969696";
  const foreignId="97979797-9797-4979-8979-979797979797";
  const threads=[
    {id:sessionId,name:"Owned fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignId,name:"Foreign fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const listCalls:string[]=[];
  const terminateCalls:Array<{threadId:string;processId:string}> = [];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[dir]}],
    listThreads:async()=>threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    async listMobileBackgroundTerminals(threadId:string){listCalls.push(threadId);return [{itemId:"item-1",processId:"42"}];},
    async terminateMobileBackgroundTerminal(threadId:string,processId:string){if(threadId!==sessionId||processId!=="42")throw new Error("Фоновый процесс не найден в выбранном сеансе");terminateCalls.push({threadId,processId});},
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentModeId:"code",accountState:async()=>({}),
  }) as unknown as AcpClient;
  const registry={controller:()=>({list:()=>[]}),get:()=>({sessionId,isBusy:true}),runtimeForSession:()=>({sessionId,isBusy:true})} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Fixture");
  owners.recordMobile(foreignId,202,dir,"Fixture");
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const listed=await agent.executeMobile({op:"listBackgroundTerminals" as never,userId:101,args:{sessionId}}) as {
      items:Array<{itemId:string;processId:string}>;
    };
    assert.deepEqual(listed.items,[{itemId:"item-1",processId:"42"}]);
    await assert.rejects(agent.executeMobile({op:"stopBackgroundTerminal" as never,userId:202,args:{sessionId,processId:"42"}}),/Доступ к сеансу запрещён/);
    await assert.rejects(agent.executeMobile({op:"stopBackgroundTerminal" as never,userId:101,args:{sessionId,processId:"999"}}),/не найден/i);
    assert.deepEqual(terminateCalls,[]);
    const stopped=await agent.executeMobile({op:"stopBackgroundTerminal" as never,userId:101,args:{sessionId,processId:"42"}}) as {stopped:boolean};
    assert.deepEqual(stopped,{stopped:true,processId:"42"});
    assert.deepEqual(terminateCalls,[{threadId:sessionId,processId:"42"}]);
    assert.ok(listCalls.every((threadId)=>threadId===sessionId));
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile edit and retry only reverts the latest owned idle text turn and submits through the shared runtime",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-turn-edit-"));
  const sessionId="98989898-9898-4989-8989-989898989898";
  const foreignId="99999999-9999-4999-8999-999999999999";
  const threads=[
    {id:sessionId,name:"Editable fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignId,name:"Foreign fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  let latestTurn={turnId:"12345678-1234-4234-8234-123456789abc",text:"$fixture-review old prompt",skillNames:["fixture-review"],attachmentCount:0,editable:true};
  const olderTurn={turnId:"87654321-4321-4234-8234-123456789abc",text:"older request",skillNames:[],attachmentCount:0,editable:true};
  let busy=false;
  let activeTurn=false;
  const reverts:Array<{threadId:string;turnId:string}>=[];
  const submitted:Array<{userId:number;text:string;skillNames?:string[]}>=[];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[dir]}],
    listThreads:async()=>threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    hasActiveTurn:(id:string)=>id===sessionId&&activeTurn,
    async readMobileLatestEditableTurn(threadId:string){assert.equal(threadId,sessionId);return {...latestTurn};},
    async readMobileEditableTurns(threadId:string){assert.equal(threadId,sessionId);return [{...latestTurn},{...olderTurn}];},
    async revertMobileThread(threadId:string,turnId:string){reverts.push({threadId,turnId});latestTurn={turnId:"abcdef01-2345-4234-8234-123456789abc",text:"edited prompt",skillNames:[],attachmentCount:0,editable:true};},
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentModeId:"code",accountState:async()=>({}),
  }) as unknown as AcpClient;
  const runtime={get isBusy(){return busy;},queueLength:0};
  const controller={list:()=>[],foreground:()=>({sessionId}),switchTo:async()=>({sessionId})};
  const registry={
    get:()=>({sessionId}),
    controller:()=>controller,
    runtimeForSession:()=>runtime,
    async submitPrompt(userId:number,input:{text:string;skillNames?:string[]}){submitted.push({userId,text:input.text,skillNames:input.skillNames});return {kind:"submitted",outcome:{stopReason:"end_turn"}};},
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Fixture");
  owners.recordMobile(foreignId,202,dir,"Fixture");
  const agent=new MiniAppAgent({cfg,acp,registry});
  const turnId="12345678-1234-4234-8234-123456789abc";
  const args={sessionId,turnId,expectedLatestTurnId:turnId,text:"$fixture-review updated prompt",requestId:"mobile-edit-123456"};
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const last=await agent.executeMobile({op:"latestEditableTurn",userId:101,args:{sessionId}}) as {editable:boolean;turnId:string};
    assert.equal(last.editable,true);
    assert.equal(last.turnId,turnId);
    const recent=await agent.executeMobile({op:"listEditableTurns",userId:101,args:{sessionId}}) as {latestTurnId:string;turns:Array<{turnId:string}>};
    assert.equal(recent.latestTurnId,turnId);
    assert.deepEqual(recent.turns.map(turn=>turn.turnId),[turnId,olderTurn.turnId]);
    await assert.rejects(agent.executeMobile({op:"editAndRetry",userId:202,args}),/Доступ к сеансу запрещён/);
    latestTurn={...latestTurn,turnId:"fedcba98-7654-4321-8765-abcdefabcdef"};
    await assert.rejects(agent.executeMobile({op:"editAndRetry",userId:101,args}),/изменил/i);
    assert.deepEqual(reverts,[]);
    latestTurn={...latestTurn,turnId};
    busy=true;
    await assert.rejects(agent.executeMobile({op:"editAndRetry",userId:101,args}),/Дождитесь завершения/);
    assert.deepEqual(reverts,[]);
    busy=false;
    activeTurn=true;
    await assert.rejects(agent.executeMobile({op:"editAndRetry",userId:101,args}),/Дождитесь завершения/);
    assert.deepEqual(reverts,[]);
    activeTurn=false;
    const result=await agent.executeMobile({op:"editAndRetry",userId:101,args}) as {result:unknown};
    assert.deepEqual(result.result,{stopReason:"end_turn"});
    const duplicate=await agent.executeMobile({op:"editAndRetry",userId:101,args}) as {result:unknown};
    assert.deepEqual(duplicate,result);
    assert.deepEqual(reverts,[{threadId:sessionId,turnId}]);
    assert.deepEqual(submitted,[{userId:101,text:"$fixture-review updated prompt",skillNames:["fixture-review"]}]);
    const olderArgs={...args,turnId:olderTurn.turnId,expectedLatestTurnId:latestTurn.turnId,requestId:"mobile-edit-older-1234",text:"revised older request"};
    const olderResult=await agent.executeMobile({op:"editAndRetry",userId:101,args:olderArgs}) as {result:unknown};
    assert.deepEqual(olderResult.result,{stopReason:"end_turn"});
    assert.deepEqual(reverts.at(-1),{threadId:sessionId,turnId:olderTurn.turnId});
    assert.deepEqual(submitted.at(-1),{userId:101,text:"revised older request",skillNames:[]});
    const mismatchedAgent=new MiniAppAgent({cfg,acp,registry});
    try{
      await assert.rejects(mismatchedAgent.executeMobile({op:"editAndRetry",userId:101,args:{...args,text:"different prompt"}}),/ID задания уже использован/);
    }finally{mismatchedAgent.stop();}
    const replayAgent=new MiniAppAgent({cfg,acp,registry});
    try{
      const replay=await replayAgent.executeMobile({op:"editAndRetry",userId:101,args}) as {result:unknown};
      assert.deepEqual(replay,result);
    }finally{replayAgent.stop();}
    assert.deepEqual(reverts,[{threadId:sessionId,turnId},{threadId:sessionId,turnId:olderTurn.turnId}]);
    assert.deepEqual(submitted,[
      {userId:101,text:"$fixture-review updated prompt",skillNames:["fixture-review"]},
      {userId:101,text:"revised older request",skillNames:[]},
    ]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile file attachments enter the shared runtime prompt with safe labels and cleanup paths",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-file-prompt-"));
  const project=join(dir,"project");
  mkdirSync(project);
  const sessionId="81818181-8181-4181-8181-818181818181";
  const thread={id:sessionId,name:"Attachment fixture",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[project]}],
    listThreads:async()=>[thread],
    listAllThreads:async()=>[thread],
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentModeId:"code",
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false,queueLength:0};
  const controller={runtimeForSession:()=>runtime,foreground:()=>runtime,list:()=>[]};
  const submitted:Array<{text:string;attachmentNames?:string[];attachmentContext?:string;attachmentPaths?:string[];displayText?:string}>=[];
  const registry={
    controller:()=>controller,
    get:()=>runtime,
    async submitPrompt(_userId:number,input:{text:string;attachmentNames?:string[];attachmentContext?:string;attachmentPaths?:string[];displayText?:string}){
      submitted.push(input);
      return {kind:"submitted",outcome:"accepted"};
    },
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,project,"Fixture");
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const binary=await saveIncomingAttachment(dir,"report.pdf",Buffer.from("%PDF-1.7\\nfixture"));
    const text="export const ready = true;";
    const result=await agent.execute({
      id:"abcdef0123456789abcdef01",op:"send",userId:101,
      args:{sessionId,text:"Проверь документы",requestId:"mobile-attachments-0001"},
    },[
      {id:"11111111-1111-4111-8111-111111111111",name:"notes.ts",mimeType:"text/plain",size:text.length,text},
      {id:"22222222-2222-4222-8222-222222222222",name:binary.name,mimeType:"application/pdf",size:18,path:binary.path},
    ]);
    assert.deepEqual(result,{result:"accepted"});
    assert.equal(submitted.length,1);
    const input=submitted[0]!;
    assert.match(input.text,/Проверь документы/);
    assert.match(input.text,/export const ready = true;/);
    assert.ok(input.text.includes(binary.path));
    assert.deepEqual(input.attachmentNames,["notes.ts","report.pdf"]);
    assert.deepEqual(input.attachmentPaths,[binary.path]);
    assert.equal(input.displayText,"Проверь документы");
    assert.match(input.attachmentContext??"",/notes\.ts/);
    assert.match(input.attachmentContext??"",/report\.pdf/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile voice transcription accepts bounded audio only for an owned session",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-voice-"));
  const sessionId="78787878-7878-4787-8787-787878787878";
  const foreignId="79797979-7979-4797-8797-797979797979";
  const threads=[
    {id:sessionId,name:"Owned voice fixture",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignId,name:"Foreign voice fixture",cwd:dir,source:"cli",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[],
    listThreads:async()=>threads,
    listAllThreads:async()=>threads,
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentModeId:"code",
  }) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Owned");
  owners.recordMobile(foreignId,202,dir,"Foreign");
  const calls:Array<{bytes:Buffer;mimeType:string;filename:string}>=[];
  const stt={enabled:true,async transcribe(bytes:Buffer,mimeType:string,filename:string){calls.push({bytes,mimeType,filename});return "  Проверь код  ";}};
  const agent=new MiniAppAgent({cfg,acp,registry:{runtimeForSession:()=>undefined} as unknown as RuntimeRegistry,stt:stt as never});
  const audio=Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE");
  const args={sessionId,mimeType:"audio/wav",data:audio.toString("base64")};
  try{
    const result=await agent.executeMobile({op:"transcribeAudio" as never,userId:101,args}) as {text:string};
    assert.equal(result.text,"Проверь код");
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0],{bytes:audio,mimeType:"audio/wav",filename:"codex-mobile-audio.wav"});
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:202,args}),/Доступ к сеансу запрещён/);
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{...args,mimeType:"text/html"}}),/формат аудио/i);
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{...args,data:"%%%"}}),/аудио/i);
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{...args,data:Buffer.from("not-a-wave").toString("base64")}}),/не похоже на аудио/i);
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{...args,data:Buffer.alloc(5*1024*1024+1).toString("base64")}}),/5 МБ/i);
    assert.equal(calls.length,1,"invalid requests must never reach speech recognition");
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile realtime voice is limited to an owned idle session and stops through the same Codex thread",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-realtime-"));
  const sessionId="74747474-7474-4474-8474-747474747474";
  const foreignId="73737373-7373-4373-8373-737373737373";
  const threads=[
    {id:sessionId,name:"Owned voice thread",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignId,name:"Foreign voice thread",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const offer="v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
  const answer="v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
  let busy=false;
  let queueLength=0;
  let activeTurn=false;
  const starts:Array<{threadId:string;sdp:string;voice?:string}>=[];
  const stops:string[]=[];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    hasActiveTurn:(id:string)=>id===sessionId&&activeTurn,
    async listRealtimeVoices(){return {voices:["marin","cedar"],defaultVoice:"marin"};},
    async startRealtime(threadId:string,sdp:string,voice?:string){starts.push({threadId,sdp,...(voice?{voice}:{})});return answer;},
    async stopRealtime(threadId:string){stops.push(threadId);},
  }) as unknown as AcpClient;
  const runtime={get isBusy(){return busy;},get queueLength(){return queueLength;}};
  const registry={runtimeForSession:(owner:number,id:string)=>owner===101&&id===sessionId?runtime:undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Owned");
  owners.recordMobile(foreignId,202,dir,"Foreign");
  const agent=new MiniAppAgent({cfg,acp,registry});
    const startArgs={sessionId,sdp:offer,voice:"cedar"};
  try{
    assert.equal(await agent.canReadSession(sessionId,101),true);
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:202,args:startArgs} as never),/Доступ к сеансу запрещён/);
    busy=true;
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:101,args:startArgs} as never),/Дождитесь завершения/);
    busy=false;
    queueLength=1;
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:101,args:startArgs} as never),/очеред/i);
    queueLength=0;
    activeTurn=true;
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:101,args:startArgs} as never),/Дождитесь завершения/);
    activeTurn=false;
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:101,args:{...startArgs,sdp:"not sdp"}} as never),/SDP|аудиосоединение/i);
    await assert.rejects(agent.executeMobile({op:"startRealtime",userId:101,args:{...startArgs,voice:"unknown"}} as never),/голос.*недоступен/i);
    const started=await agent.executeMobile({op:"startRealtime",userId:101,args:startArgs} as never) as {sdp:string};
    assert.deepEqual(started,{sdp:answer});
    assert.deepEqual(starts,[{threadId:sessionId,sdp:offer,voice:"cedar"}]);
    assert.deepEqual(await agent.executeMobile({op:"listRealtimeVoices",userId:101,args:{sessionId}} as never),{voices:["marin","cedar"],defaultVoice:"marin"});
    await assert.rejects(agent.executeMobile({op:"listRealtimeVoices",userId:202,args:{sessionId}} as never),/Доступ к сеансу запрещён/);
    await agent.executeMobile({op:"stopRealtime",userId:101,args:{sessionId}} as never);
    await assert.rejects(agent.executeMobile({op:"stopRealtime",userId:202,args:{sessionId}} as never),/Доступ к сеансу запрещён/);
    assert.deepEqual(stops,[sessionId]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile voice transcription stays disabled until the existing speech endpoint is configured",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-voice-disabled-"));
  const sessionId="76767676-7676-4676-8676-767676767676";
  const thread={id:sessionId,name:"Owned voice fixture",cwd:dir,source:"cli",createdAt:1,updatedAt:1,recencyAt:1};
  const acp=Object.assign(new EventEmitter(),{listProjects:async()=>[],listThreads:async()=>[thread],listAllThreads:async()=>[thread]}) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Owned");
  let called=false;
  const stt={enabled:false,async transcribe(){called=true;return "unexpected";}};
  const agent=new MiniAppAgent({cfg,acp,registry:{runtimeForSession:()=>undefined} as unknown as RuntimeRegistry,stt:stt as never});
  try{
    await assert.rejects(agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{sessionId,mimeType:"audio/webm",data:Buffer.from("fixture").toString("base64")}}),/распознавание речи не настроено/i);
    assert.equal(called,false);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile voice transcription hides upstream errors from the paired device",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-voice-error-"));
  const sessionId="75757575-7575-4575-8575-757575757575";
  const thread={id:sessionId,name:"Owned voice fixture",cwd:dir,source:"cli",createdAt:1,updatedAt:1,recencyAt:1};
  const acp=Object.assign(new EventEmitter(),{listProjects:async()=>[],listThreads:async()=>[thread],listAllThreads:async()=>[thread]}) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Owned");
  const stt={enabled:true,async transcribe(){throw new Error("STT HTTP 500: provider-internal-secret");}};
  const agent=new MiniAppAgent({cfg,acp,registry:{runtimeForSession:()=>undefined} as unknown as RuntimeRegistry,stt:stt as never});
  try{
    await assert.rejects(
      agent.executeMobile({op:"transcribeAudio" as never,userId:101,args:{sessionId,mimeType:"audio/wav",data:Buffer.from("RIFF\u0004\u0000\u0000\u0000WAVE").toString("base64")}}),
      (error:unknown)=>error instanceof Error&&/не удалось распознать аудио/i.test(error.message)&&!error.message.includes("provider-internal-secret"),
    );
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile native search finds older sessions without exposing another owner's session",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-search-"));
  const ownedId="91919191-9191-4191-8191-919191919191";
  const foreignId="92929292-9292-4292-8292-929292929292";
  const olderId="93939393-9393-4393-8393-939393939393";
  let requested:Record<string,unknown>|undefined;
  const acp=Object.assign(new EventEmitter(),{
    async listProjects(){return [];},
    async listAllThreads(){return [];},
    async listThreadsPage(params:Record<string,unknown>={}){
      requested=params;
      return {threads:[
        {id:olderId,name:"Old migration notes",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2},
        {id:ownedId,name:"Migration design",cwd:dir,source:"appServer",createdAt:1,updatedAt:3,recencyAt:3},
        {id:foreignId,name:"Private migration",cwd:dir,source:"cli",createdAt:1,updatedAt:4,recencyAt:4},
      ],nextCursor:"native-page-2"};
    },
  }) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  new TelegramSessionRegistry(dir).record(foreignId,202,dir,"private");
  new TelegramSessionRegistry(dir).record(ownedId,101,dir,"owned");
  const agent=new MiniAppAgent({cfg,acp,registry:{runtimeForSession:()=>undefined} as unknown as RuntimeRegistry});
  try{
    const result=await agent.executeMobile({op:"searchThreads",userId:101,args:{query:"migration",cursor:"native-page-1"}}) as {
      sessions:Array<{id:string;title:string;cwd:string;archived:boolean}>;nextCursor?:string;
    };
    assert.equal(requested?.searchTerm,"migration");
    assert.equal(requested?.cursor,"native-page-1");
    assert.deepEqual(result.sessions.map((session)=>session.id),[olderId,ownedId]);
    assert.equal(result.nextCursor,"native-page-2");
    assert.equal(result.sessions[1]?.title,"Migration design");
    assert.equal(result.sessions[1]?.cwd,dir);
    assert.equal(result.sessions[1]?.archived,false);
    await assert.rejects(agent.executeMobile({op:"searchThreads",userId:101,args:{query:"migration",cwd:join(dir,"outside")}}),/Папка проекта не разрешена/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile session pages continue past the snapshot cap within the selected project and hide foreign threads",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-session-pages-"));
  const project=join(dir,"workspace"),otherProject=join(dir,"other");
  mkdirSync(project);mkdirSync(otherProject);
  const foreignIds=new Set<string>();
  const targetThreads=Array.from({length:620},(_,index)=>{
    const id=`target-session-${String(index).padStart(3,"0")}`;
    if(index%52===0)foreignIds.add(id);
    return {id,name:`Target ${index}`,cwd:project,source:"cli",createdAt:index,updatedAt:index,recencyAt:10000-index};
  });
  const otherThreads=Array.from({length:20},(_,index)=>{
    const id=`other-session-${String(index).padStart(3,"0")}`;
    return {id,name:`Other ${index}`,cwd:otherProject,source:"cli",createdAt:index,updatedAt:index,recencyAt:5000-index};
  });
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"workspace",roots:[project]},{id:"p2",name:"other",roots:[otherProject]}],
    listThreads:async()=>[...targetThreads,...otherThreads],availableModels:[],
  }) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project,otherProject],allowedUsers:new Set(["101"])} as AppConfig;
  const sessions=new TelegramSessionRegistry(dir);
  for(const id of foreignIds)sessions.record(id,202,project,"private");
  const agent=new MiniAppAgent({cfg,acp,registry:{get:()=>({sessionId:""}),runtimeForSession:()=>undefined,controller:()=>({list:()=>[]})} as unknown as RuntimeRegistry});
  try{
    const snapshot=await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}}) as {sessions:Array<{id:string}>};
    assert.equal(snapshot.sessions.length,500);
    assert.equal(snapshot.sessions.some((entry)=>foreignIds.has(entry.id)),false);
    const page=await agent.executeMobile({op:"listMoreThreads" as never,userId:101,args:{offset:500,cwd:project}}) as {
      sessions:Array<{id:string;cwd:string}>;nextOffset?:number;
    };
    assert.equal(page.sessions.length,100);
    assert.ok(page.sessions.every((entry)=>entry.cwd===project&&!foreignIds.has(entry.id)));
    assert.equal(page.nextOffset,600);
    const end=await agent.executeMobile({op:"listMoreThreads" as never,userId:101,args:{offset:600,cwd:project}}) as {sessions:Array<unknown>;nextOffset?:number};
    assert.equal(end.sessions.length,8);
    assert.equal(end.nextOffset,undefined);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile terminal runs a bounded one-shot command in the authorized project and refuses a busy Codex session",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-terminal-"));
  const project=join(dir,"workspace");
  const sessionId="94949494-9494-4494-8494-949494949494";
  mkdirSync(project);
  const thread={id:sessionId,name:"Terminal fixture",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const acp=Object.assign(new EventEmitter(),{
    async listProjects(){return [{id:"terminal-project",name:"workspace",roots:[project]}];},
    async listThreads(){return [thread];},
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false,queueLength:0};
  const registry={runtimeForSession:()=>runtime,controller:()=>({list:()=>[]})} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  const command=process.platform==="win32"?"Write-Output mobile-terminal-ok; (Get-Location).Path":"printf 'mobile-terminal-ok\\n'; pwd";
  try{
    const result=await agent.executeMobile({op:"terminalExec" as never,userId:101,args:{sessionId,command}}) as {
      exitCode:number;stdout:string;stderr:string;
    };
    assert.equal(result.exitCode,0);
    assert.match(result.stdout,/mobile-terminal-ok/);
    assert.match(result.stdout.toLowerCase(),/workspace/);
    const largeCommand=process.platform==="win32"?"[Console]::Out.Write('x' * 70000)":"printf '%070000d' 0 | tr 0 x";
    const largeResult=await agent.executeMobile({op:"terminalExec" as never,userId:101,args:{sessionId,command:largeCommand}}) as {
      stdout:string;truncated:boolean;
    };
    assert.equal(largeResult.truncated,true);
    assert.ok(largeResult.stdout.length<=65_600,"terminal output remains bounded after truncation");
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"terminalExec" as never,userId:101,args:{sessionId,command}}),/Дождитесь завершения текущей задачи/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile interactive terminal reattaches, streams output, scopes input and stops the project shell",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-pty-"));
  const project=join(dir,"workspace");
  const sessionId="95959595-9595-4595-8595-959595959595";
  mkdirSync(project);
  const acp=Object.assign(new EventEmitter(),{
    async listProjects(){return [{id:"pty-project",name:"workspace",roots:[project]}];},
    async listThreads(params?:{archived?:boolean}){return params?.archived?[]:[{id:sessionId,name:"PTY fixture",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2}];},
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false,queueLength:0};
  const registry={runtimeForSession:()=>runtime,get:()=>runtime,controller:()=>({list:()=>[]})} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  let onData:(value:string)=>void=()=>{};
  let onExit:(value:{exitCode:number})=>void=()=>{};
  const writes:string[]=[];
  const sizes:Array<[number,number]>=[];
  const launches:Array<{shell:string;args:string[];options:MobilePtyOptions}>=[];
  let killed=false;
  const pty:MobilePtyProcess={
    write(value:string){writes.push(value);},resize(cols:number,rows:number){sizes.push([cols,rows]);},
    kill(){killed=true;onExit({exitCode:0});},
    onData(listener:(value:string)=>void){onData=listener;return {dispose(){}};},
    onExit(listener:(value:{exitCode:number})=>void){onExit=listener;return {dispose(){}};},
  };
  const mobilePtyFactory:MobilePtyFactory=(shell,args,options)=>{
    launches.push({shell,args,options});return pty;
  };
  const agent=new MiniAppAgent({cfg,acp,registry,mobilePtyFactory});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const started=await agent.executeMobile({op:"terminalStart" as never,userId:101,args:{sessionId}}) as {terminalId:string;reused:boolean};
    assert.match(started.terminalId,/^[a-f0-9-]{36}$/i);
    assert.equal(started.reused,false);
    assert.equal(launches.length,1);
    assert.equal(launches[0]?.options.cwd,realpathSync.native(project));
    const attached=await agent.executeMobile({op:"terminalStart" as never,userId:101,args:{sessionId}}) as {terminalId:string;reused:boolean};
    assert.equal(attached.terminalId,started.terminalId);
    assert.equal(attached.reused,true);
    assert.equal(launches.length,1,"reattaching must keep the same shell process");

    onData("fixture output\r\n");
    const output=await agent.executeMobile({op:"terminalRead" as never,userId:101,args:{sessionId,terminalId:started.terminalId,offset:0}}) as {
      output:string;nextOffset:number;exited:boolean;
    };
    assert.equal(output.output,"fixture output\r\n");
    assert.equal(output.nextOffset,16);
    assert.equal(output.exited,false);
    const tail=await agent.executeMobile({op:"terminalRead" as never,userId:101,args:{sessionId,terminalId:started.terminalId,offset:output.nextOffset}}) as {output:string};
    assert.equal(tail.output,"");
    onData("x".repeat(512*1024+10));
    const bounded=await agent.executeMobile({op:"terminalRead" as never,userId:101,args:{sessionId,terminalId:started.terminalId,offset:0}}) as {
      output:string;nextOffset:number;truncated:boolean;
    };
    assert.equal(bounded.truncated,true);
    assert.equal(bounded.output.length,64*1024,"one poll returns a bounded chunk even after reconnect");
    assert.equal(bounded.nextOffset,16+10+64*1024);

    await agent.executeMobile({op:"terminalInput" as never,userId:101,args:{sessionId,terminalId:started.terminalId,data:"echo safe\r"}});
    assert.deepEqual(writes,["echo safe\r"]);
    await agent.executeMobile({op:"terminalResize" as never,userId:101,args:{sessionId,terminalId:started.terminalId,cols:90,rows:30}});
    assert.deepEqual(sizes,[[90,30]]);
    await assert.rejects(agent.executeMobile({op:"terminalRead" as never,userId:101,args:{sessionId:"96969696-9696-4696-8696-969696969696",terminalId:started.terminalId,offset:0}}),/Доступ к сеансу запрещён/);
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"terminalStart" as never,userId:101,args:{sessionId}}),/Дождитесь завершения текущей задачи/);
    runtime.isBusy=false;
    await agent.executeMobile({op:"terminalStop" as never,userId:101,args:{sessionId,terminalId:started.terminalId}});
    assert.equal(killed,true);
    const stopped=await agent.executeMobile({op:"terminalRead" as never,userId:101,args:{sessionId,terminalId:started.terminalId,offset:16}}) as {exited:boolean;exitCode:number|null};
    assert.equal(stopped.exited,true);
    assert.equal(stopped.exitCode,0);
    killed=false;
    const replacement=await agent.executeMobile({op:"terminalStart" as never,userId:101,args:{sessionId}}) as {terminalId:string};
    assert.notEqual(replacement.terminalId,started.terminalId);
    agent.stop();
    assert.equal(killed,true,"agent shutdown must stop an open local shell");
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
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
  const mcpResourceReads:Array<{threadId:string;server:string;uri:string;uriTemplate?:string}>=[];
  const runtime={
    sessionId,model:"fixture-model",agent:"code",reasoning:"medium" as ReasoningEffort,
    async setModelPref(value:string){this.model=value;return {ok:true};},
    async setAgentPref(value:string){this.agent=value;return {ok:true};},
    setReasoningPref(value:ReasoningEffort){this.reasoning=value;},
  };
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"toy",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[{id:sessionId,name:"Mobile settings",cwd:dir,source:"cli",recencyAt:2}],
    hasInflightPrompt:()=>false,
    refreshInventories:async()=>{inventoryRefreshes++;},
    accountState:async()=>({account:{type:"chatgpt",email:"owner@example.invalid",planType:"Plus"},
      rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:123}}}),
    availableModels:[{modelId:"fixture-model",name:"Fixture model",description:"Model description"}],
    availableModes:[{id:"code",name:"Code",description:"Code mode"}],
    currentModelId:"fixture-model",currentModeId:"code",
    availableSkills:[{name:"fixture-skill",description:"Safe text",path:"C:\\private\\skill\\SKILL.md",enabled:true}],
    availableMcpServers:[{name:"fixture-mcp",runtimeStatus:"connected",tools:{run:{token:"must not escape"}},resources:[{
      uri:"fixture://private/account",name:"Account notes",description:"Safe fixture notes",mimeType:"text/plain",
    }],resourceTemplates:[{
      uriTemplate:"fixture://accounts/{account_id}/report",name:"Account report",description:"Read a named account report",mimeType:"text/plain",
    }]}],
    async readMobileMcpResource(threadId:string,server:string,uri:string,uriTemplate?:string){
      mcpResourceReads.push({threadId,server,uri,...(uriTemplate?{uriTemplate}:{})});
      return {text:"Private notes",truncated:false,omittedContentBlocks:0};
    },
    currentSubagents:()=>[
      {sessionId:"own-agent",agentName:"Own agent",status:{type:"running"}},
      {sessionId:"other-agent",agentName:"Other agent",status:{type:"running"}},
    ],
    hasModel:(id:string)=>id==="fixture-model",
    hasMode:(id:string)=>id==="code",
  }) as unknown as AcpClient;
  Object.defineProperty(acp,"isConnected",{value:true});
  const registry={
    hasPendingWork:()=>false,
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
      skills:Array<{name:string}>;mcpServers:Array<{toolCount:number;resources?:Array<{id:string;name:string;parameters?:string[]}>}>;subagents:Array<{id:string}>;limits:Array<{primary?:{usedPercent:number}}>;
    };
    assert.equal(inventoryRefreshes,1);
    assert.equal(capabilities.skills[0]?.name,"fixture-skill");
    assert.equal(capabilities.mcpServers[0]?.toolCount,1);
    assert.deepEqual(capabilities.mcpServers[0]?.resources?.map(({name})=>name),["Account notes","Account report"]);
    const templateResource=capabilities.mcpServers[0]!.resources![1]!;
    assert.deepEqual(templateResource.parameters,["account_id"]);
    assert.deepEqual(capabilities.subagents.map((entry)=>entry.id),["own-agent"]);
    assert.equal(capabilities.limits[0]?.primary?.usedPercent,12);
    assert.doesNotMatch(JSON.stringify(capabilities),/C:\\\\private|must not escape|fixture:\/\//);
    const resourceId=capabilities.mcpServers[0]!.resources![0]!.id;
    const resourceResult=await agent.executeMobile({op:"readMcpResource",userId:101,args:{sessionId,resourceId}}) as {text:string};
    assert.equal(resourceResult.text,"Private notes");
    assert.deepEqual(mcpResourceReads,[{threadId:sessionId,server:"fixture-mcp",uri:"fixture://private/account"}]);
    await assert.rejects(agent.executeMobile({op:"readMcpResource",userId:101,args:{sessionId,resourceId:templateResource.id,parameters:{}}}),/параметр/i);
    assert.equal(mcpResourceReads.length,1);
    const templateResult=await agent.executeMobile({op:"readMcpResource",userId:101,args:{sessionId,resourceId:templateResource.id,parameters:{account_id:"north america"}}}) as {text:string};
    assert.equal(templateResult.text,"Private notes");
    assert.deepEqual(mcpResourceReads[1],{
      threadId:sessionId,server:"fixture-mcp",uri:"fixture://accounts/north%20america/report",
      uriTemplate:"fixture://accounts/{account_id}/report",
    });
    await assert.rejects(agent.executeMobile({op:"readMcpResource",userId:101,args:{sessionId:"99999999-9999-4999-8999-999999999999",resourceId}}),/Доступ к сеансу запрещён/);
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

test("mobile MCP OAuth is limited to a configured login-required server in an owned idle thread",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-mcp-oauth-"));
  const sessionId="22222222-2222-4222-8222-222222222222";
  const thread={id:sessionId,name:"MCP OAuth",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const calls:Array<{name:string;threadId:string}> = [];
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"project",roots:[dir]}],
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[thread],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[thread],
    listMobileMcpServers:async()=>[
      {name:"fixture-mcp",runtimeStatus:"authenticationRequired",authStatus:"needs_auth"},
      {name:"already-authorized",runtimeStatus:"connected",authStatus:"oauth"},
    ],
    async startMobileMcpOAuthLogin(name:string,id:string){calls.push({name,threadId:id});return {authorizationUrl:"https://login.example.invalid/authorize?fixture=1"};},
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentModeId:"code",accountState:async()=>({}),
  }) as unknown as AcpClient;
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const result=await agent.executeMobile({op:"mcpOAuthLogin" as never,userId:101,args:{sessionId,name:"fixture-mcp"}}) as {authorizationUrl:string};
    assert.equal(result.authorizationUrl,"https://login.example.invalid/authorize?fixture=1");
    assert.deepEqual(calls,[{name:"fixture-mcp",threadId:sessionId}]);
    await assert.rejects(agent.executeMobile({op:"mcpOAuthLogin" as never,userId:101,args:{sessionId,name:"not-configured"}}),/не найден|не требует входа/i);
    await assert.rejects(agent.executeMobile({op:"mcpOAuthLogin" as never,userId:202,args:{sessionId,name:"fixture-mcp"}}),/не разрешён/i);
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"mcpOAuthLogin" as never,userId:101,args:{sessionId,name:"fixture-mcp"}}),/Дождитесь завершения/);
    assert.equal(calls.length,1);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile MCP tool calls require an owned idle thread and reuse its connected ACP server",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-mcp-tool-agent-"));
  const sessionId="31313131-3131-4131-8131-313131313131";
  const foreignSessionId="32323232-3232-4232-8232-323232323232";
  const threads=[
    {id:sessionId,name:"Owned MCP thread",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignSessionId,name:"Foreign MCP thread",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Fixture");
  owners.recordMobile(foreignSessionId,202,dir,"Fixture");
  let busy=false;
  let pending=false;
  let online=true;
  const calls:Array<{threadId:string;server:string;tool:string;arguments:unknown}>=[];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    hasInflightPrompt:()=>busy,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[dir]}],
    listThreads:async()=>threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],currentModelId:"default",
    async callMobileMcpTool(threadId:string,server:string,tool:string,args:unknown){
      calls.push({threadId,server,tool,arguments:args});
      return {text:"Fixture MCP result",isError:false,truncated:false,omittedContentBlocks:0};
    },
  }) as unknown as AcpClient;
  Object.defineProperty(acp,"isConnected",{get:()=>online});
  const runtime={sessionId,isBusy:false,queueLength:0};
  const registry={
    hasPendingWork:()=>pending,
    runtimeForSession:(owner:number,id:string)=>owner===101&&id===sessionId?runtime:undefined,
    ownerChatForSession:(id:string)=>id===sessionId?101:id===foreignSessionId?202:undefined,
    controller:()=>({list:()=>[]}),get:()=>runtime,
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  const perform=(userId:number,args:Record<string,unknown>)=>agent.executeMobile({op:"callMcpTool",userId,args} as never);
  try{
    await agent.execute({id:"aabbccddeeff001122334455",op:"snapshot",userId:101,args:{}});
    await assert.rejects(perform(101,{sessionId:foreignSessionId,server:"fixture-mcp",tool:"read_status",arguments:{}}),/Доступ к сеансу запрещён/);
    busy=true;
    await assert.rejects(perform(101,{sessionId,server:"fixture-mcp",tool:"read_status",arguments:{}}),/Дождитесь завершения/);
    busy=false;
    pending=true;
    await assert.rejects(perform(101,{sessionId,server:"fixture-mcp",tool:"read_status",arguments:{}}),/очередь|задач Codex/i);
    pending=false;
    online=false;
    await assert.rejects(perform(101,{sessionId,server:"fixture-mcp",tool:"read_status",arguments:{}}),/офлайн/i);
    online=true;
    const result=await perform(101,{sessionId,server:"fixture-mcp",tool:"read_status",arguments:{query:"latest"}});
    assert.deepEqual(result,{text:"Fixture MCP result",isError:false,truncated:false,omittedContentBlocks:0});
    assert.deepEqual(calls,[{threadId:sessionId,server:"fixture-mcp",tool:"read_status",arguments:{query:"latest"}}]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile skill controls expose disabled skills without local paths and write only one authorized skill",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-skills-"));
  const sessionId="21212121-2121-4212-8212-212121212121";
  const thread={id:sessionId,name:"Skill session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const skillRows=[
    {name:"review",description:"Review project changes",path:join(dir,".codex","skills","review","SKILL.md"),scope:"user" as const,enabled:true},
    {name:"disabled-helper",description:"Disabled helper",path:join(dir,".codex","skills","disabled","SKILL.md"),scope:"repo" as const,enabled:false},
    {name:"managed",description:"Managed skill",path:"C:\\private\\managed\\SKILL.md",scope:"admin" as const,enabled:true},
  ];
  const skillCalls:Array<{op:string;name?:string;enabled?:boolean;cwd?:string}>=[];
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"skill-project",roots:[dir]}],
    listAllThreads:async()=>[thread],
    listThreads:async()=>[thread],
    refreshInventories:async()=>undefined,
    accountState:async()=>({}),
    mobileIntegrationInventory:async()=>({pluginCatalog:{marketplaces:[]},installedPlugins:{marketplaces:[]},apps:{data:[]},installedApps:{apps:[]}}),
    listMobileSkills:async(cwd:string)=>{skillCalls.push({op:"list",cwd});return skillRows;},
    async setMobileSkillEnabled(name:string,enabled:boolean,cwd:string){skillCalls.push({op:"write",name,enabled,cwd});return enabled;},
    currentSubagents:()=>[],availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],currentModelId:"default",
  }) as unknown as AcpClient;
  const registry={runtimeForSession:()=>runtime,ownerChatForSession:()=>101} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const capabilities=await agent.executeMobile({op:"capabilities",userId:101,args:{sessionId}}) as {
      skills:Array<{name:string;enabled:boolean;scope?:string;canToggle:boolean}>;
    };
    assert.deepEqual(capabilities.skills.map(({name,enabled,scope,canToggle})=>({name,enabled,scope,canToggle})),[
      {name:"review",enabled:true,scope:"user",canToggle:true},
      {name:"disabled-helper",enabled:false,scope:"repo",canToggle:true},
      {name:"managed",enabled:true,scope:"admin",canToggle:false},
    ]);
    assert.doesNotMatch(JSON.stringify(capabilities),/C:\\\\private|SKILL\\.md/);
    assert.deepEqual(skillCalls[0],{op:"list",cwd:dir});
    assert.deepEqual(await agent.executeMobile({op:"setSkillEnabled",userId:101,args:{sessionId,name:"review",enabled:false}}),{name:"review",enabled:false});
    assert.deepEqual(skillCalls[1],{op:"write",name:"review",enabled:false,cwd:dir});
    await assert.rejects(agent.executeMobile({op:"setSkillEnabled",userId:202,args:{sessionId,name:"review",enabled:false}}),/не разрешён/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile MCP config is session scoped and restart refuses shared runtime work",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-mcp-agent-"));
  const codexHome=join(dir,"codex-home");
  const project=join(dir,"project");
  mkdirSync(codexHome);
  mkdirSync(project);
  mkdirSync(join(project,".codex"));
  writeFileSync(join(project,".codex","config.toml"),`[mcp_servers.fixture]\ncommand = "fixture-server"\n`);
  const previousHome=process.env.CODEX_HOME;
  process.env.CODEX_HOME=codexHome;
  const sessionId="31313131-3131-4131-8131-313131313131";
  const foreignSessionId="32323232-3232-4232-8232-323232323232";
  const threads=[
    {id:sessionId,name:"Owned MCP",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignSessionId,name:"Foreign MCP",cwd:project,source:"cli",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,project,"Owned");
  owners.recordMobile(foreignSessionId,202,project,"Foreign");
  let pending=true;
  let busy=false;
  let restarts=0;
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    hasInflightPrompt:()=>busy,
    async restart(){restarts++;},
    listProjects:async()=>[{id:"p1",name:"fixture",roots:[project]}],
    listThreads:async()=>threads,
    listAllThreads:async()=>threads,
  }) as unknown as AcpClient;
  const registry={
    hasPendingWork:()=>pending,
    runtimeForSession:()=>undefined,
    ownerChatForSession:(id:string)=>id===sessionId?101:id===foreignSessionId?202:undefined,
    controller:()=>({list:()=>[]}),get:()=>({sessionId}),
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101","202"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const listed=await agent.executeMobile({op:"listMcpConfig" as never,userId:101,args:{sessionId}}) as Array<Record<string,unknown>>;
    assert.deepEqual(listed,[{name:"fixture",scope:"workspace",enabled:true,transport:"stdio"}]);
    assert.deepEqual(await agent.executeMobile({op:"setMcpConfigEnabled" as never,userId:101,args:{sessionId,name:"fixture",enabled:false}}),
      {name:"fixture",scope:"workspace",enabled:false,transport:"stdio",restartRequired:true});
    assert.doesNotMatch(JSON.stringify(listed),/fixture-server|config\.toml/);
    await assert.rejects(agent.executeMobile({op:"setMcpConfigEnabled" as never,userId:202,args:{sessionId,name:"fixture",enabled:true}}),/Доступ к сеансу запрещён/);
    await assert.rejects(agent.executeMobile({op:"restartCodex" as never,userId:101,args:{sessionId}}),/ожидающие запросы/);
    assert.equal(restarts,0);
    pending=false;
    busy=true;
    await assert.rejects(agent.executeMobile({op:"restartCodex" as never,userId:101,args:{sessionId}}),/Codex занят/);
    assert.equal(restarts,0);
    busy=false;
    assert.deepEqual(await agent.executeMobile({op:"restartCodex" as never,userId:101,args:{sessionId}}),{restarted:true});
    assert.equal(restarts,1);
  }finally{
    agent.stop();
    if(previousHome===undefined)delete process.env.CODEX_HOME; else process.env.CODEX_HOME=previousHome;
    rmSync(dir,{recursive:true,force:true});
  }
});

test("mobile marketplace changes require an owned idle session and use the shared ACP",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-marketplace-agent-"));
  const sessionId="34343434-3434-4434-8434-343434343434";
  const foreignSessionId="35353535-3535-4535-8535-353535353535";
  const threads=[
    {id:sessionId,name:"Owned marketplace",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2},
    {id:foreignSessionId,name:"Foreign marketplace",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(sessionId,101,dir,"Fixture");
  owners.recordMobile(foreignSessionId,202,dir,"Fixture");
  let busy=false;
  let pending=false;
  const operations:Array<Record<string,unknown>>=[];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    hasInflightPrompt:()=>busy,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[dir]}],
    listThreads:async()=>threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",
    async addMobileMarketplace(source:string,refName?:string){operations.push({op:"add",source,refName});return {marketplaceName:"fixture-market",alreadyAdded:false};},
    async removeMobileMarketplace(marketplaceName:string){operations.push({op:"remove",marketplaceName});},
    async upgradeMobileMarketplace(marketplaceName:string){operations.push({op:"upgrade",marketplaceName});},
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false,queueLength:0};
  const registry={
    hasPendingWork:()=>pending,
    runtimeForSession:()=>runtime,
    ownerChatForSession:(id:string)=>id===sessionId?101:id===foreignSessionId?202:undefined,
    controller:()=>({list:()=>[]}),get:()=>runtime,
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  const perform=(op:string,userId:number,args:Record<string,unknown>)=>agent.executeMobile({op,userId,args} as never);
  try{
    await agent.execute({id:"aabbccddeeff001122334455",op:"snapshot",userId:101,args:{}});
    await assert.rejects(perform("addMarketplace",202,{sessionId,source:"owner/repo"}),/Доступ к сеансу запрещён/);
    busy=true;
    await assert.rejects(perform("upgradeMarketplace",101,{sessionId,marketplaceName:"fixture-market"}),/Дождитесь завершения/);
    busy=false;
    pending=true;
    await assert.rejects(perform("removeMarketplace",101,{sessionId,marketplaceName:"fixture-market"}),/всех задач Codex/i);
    pending=false;
    assert.deepEqual(await perform("addMarketplace",101,{sessionId,source:"owner/repo",refName:"stable"}),
      {marketplaceName:"fixture-market",alreadyAdded:false});
    assert.deepEqual(await perform("upgradeMarketplace",101,{sessionId,marketplaceName:"fixture-market"}),
      {marketplaceName:"fixture-market",upgraded:true});
    assert.deepEqual(await perform("removeMarketplace",101,{sessionId,marketplaceName:"fixture-market"}),
      {marketplaceName:"fixture-market",removed:true});
    assert.deepEqual(operations,[
      {op:"add",source:"owner/repo",refName:"stable"},
      {op:"upgrade",marketplaceName:"fixture-market"},
      {op:"remove",marketplaceName:"fixture-market"},
    ]);
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

test("mobile deletion is limited to an owned idle archived thread and clears its local references",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-delete-thread-"));
  const archivedId="81818181-8181-4181-8181-818181818181";
  const foreignId="82828282-8282-4282-8282-828282828282";
  const activeId="83838383-8383-4383-8383-838383838383";
  const archived={id:archivedId,name:"Archived fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1};
  const foreign={id:foreignId,name:"Foreign archived fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1};
  const active={id:activeId,name:"Active fixture",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1};
  const archivedIds=new Set([archivedId,foreignId]);
  const calls:string[]=[];
  const activeTurns=new Set<string>();
  let online=true;
  let deleteFailure=false;
  let activeOwner:number|undefined;
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[archived,foreign].filter((thread)=>archivedIds.has(thread.id)):[active],
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[archived,foreign].filter((thread)=>archivedIds.has(thread.id)):[active],
    hasActiveTurn:(id:string)=>activeTurns.has(id),
    deleteThread:async(id:string)=>{calls.push(id);if(deleteFailure)throw new Error("Codex deletion refused");archivedIds.delete(id);},
  });
  Object.defineProperty(acp,"isConnected",{get:()=>online});
  const typedAcp=acp as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===archivedId&&(busyState.busy||busyState.queueLength>0||busyState.linked)?{sessionId:id,isBusy:busyState.busy,queueLength:busyState.queueLength}:undefined,
    ownerChatForSession:()=>activeOwner} as unknown as RuntimeRegistry;
  const busyState={busy:false,queueLength:0,linked:false};
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.recordMobile(archivedId,101,dir,"Fixture");
  owners.recordMobile(foreignId,202,dir,"Fixture");
  const agent=new MiniAppAgent({cfg,acp:typedAcp,registry});
  const perform=(userId:number,sessionId:string)=>agent.executeMobile({op:"deleteThread",userId,args:{sessionId}} as never);
  try{
    assert.equal(await agent.canReadSession(archivedId,101),true);
    assert.equal(await agent.canReadSession(foreignId,101),false);
    await assert.rejects(perform(101,foreignId),/доступ|запрещ/i);
    await assert.rejects(perform(101,activeId),/архив/i);
    assert.deepEqual(calls,[]);

    busyState.busy=true;
    await assert.rejects(perform(101,archivedId),/занят|выполня/i);
    busyState.busy=false;
    busyState.queueLength=1;
    await assert.rejects(perform(101,archivedId),/очеред|выполня/i);
    busyState.queueLength=0;
    activeTurns.add(archivedId);
    await assert.rejects(perform(101,archivedId),/занят|выполня/i);
    activeTurns.clear();
    busyState.linked=true;
    await assert.rejects(perform(101,archivedId),/отключите/i);
    busyState.linked=false;
    activeOwner=202;
    await assert.rejects(perform(101,archivedId),/управляет Telegram или другой клиент/i);
    activeOwner=undefined;
    const mobilePtys=(agent as unknown as {mobilePtys:Map<string,unknown>}).mobilePtys;
    mobilePtys.set("fixture-live-shell",{ownerId:101,sessionId:archivedId,exited:false,closed:false});
    await assert.rejects(perform(101,archivedId),/терминал/i);
    mobilePtys.clear();
    online=false;
    await assert.rejects(perform(101,archivedId),/офлайн/i);
    online=true;
    deleteFailure=true;
    await assert.rejects(perform(101,archivedId),/Codex deletion refused/);
    assert.equal(await agent.canReadSession(archivedId,101),true,"a rejected Codex delete must preserve the cached session");
    assert.equal(new TelegramSessionRegistry(dir).getOwner(archivedId)?.chatId,101,"a rejected Codex delete must preserve the persisted owner record");

    deleteFailure=false;
    await perform(101,archivedId);
    assert.deepEqual(calls,[archivedId,archivedId]);
    assert.equal(new TelegramSessionRegistry(dir).getOwner(archivedId),undefined,"the deleted thread's persisted owner record must be cleared");
    assert.equal(await agent.canReadSession(archivedId,101),false,"a deleted thread must stop being readable through cached history");
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

test("mobile side chat creates an owner-only ephemeral fork while the parent is working",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-side-chat-"));
  const sourceId="71717171-7171-4171-8171-717171717171";
  const sideId="81818181-8181-4181-8181-818181818181";
  const source={id:sourceId,name:"Active source",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2};
  const side={thread:{id:sideId,name:"Active source · side chat",source:"appServer",ephemeral:true},cwd:dir};
  let forkOptions:unknown;
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    availableModels:[],
    currentModelId:"fixture",
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async()=>[source],
    listAllThreads:async()=>[source],
    hasActiveTurn:(id:string)=>id===sourceId,
    forkThread:async(_id:string,options:unknown)=>{forkOptions=options;return side;},
  }) as unknown as AcpClient;
  const sideController={list:()=>[],runtimeForSession:()=>undefined};
  const registry={runtimeForSession:(_owner:number,id:string)=>id===sourceId?{sessionId:id,isBusy:true}:undefined,
    ownerChatForSession:()=>undefined,controller:()=>sideController,get:()=>({sessionId:sourceId})} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101","202"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const result=await agent.executeMobile({op:"createSideChat",userId:101,args:{sessionId:sourceId}} as never) as {sessionId?:string};
    assert.equal(result.sessionId,sideId);
    assert.deepEqual(forkOptions,{ephemeral:true,excludeTurns:true});
    assert.equal(await agent.canReadSession(sideId,101),true);
    assert.equal(await agent.canReadSession(sideId,202),false);
    const snapshot=await agent.execute({op:"snapshot",userId:101,args:{}} as never) as {sessions:Array<{id:string;ephemeral?:boolean;parentThreadId?:string}>};
    const visibleSideChat=snapshot.sessions.find((session)=>session.id===sideId);
    assert.equal(visibleSideChat?.ephemeral,true);
    assert.equal(visibleSideChat?.parentThreadId,sourceId);
    const foreignSnapshot=await agent.execute({op:"snapshot",userId:202,args:{}} as never) as {sessions:Array<{id:string}>};
    assert.equal(foreignSnapshot.sessions.some((session)=>session.id===sideId),false);
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

test("mobile native code review validates the owner thread, target and idle runtime",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-review-"));
  const sessionId="81818181-8181-4181-8181-818181818181";
  const thread={id:sessionId,name:"Review session",cwd:dir,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const runtime={sessionId,isBusy:false};
  let activeTurn=false;
  const calls:Array<{threadId:string;target:unknown;delivery:string}> = [];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[dir]}],
    listThreads:async()=>[thread],
    hasActiveTurn:()=>activeTurn,
    reviewThread:async(threadId:string,target:unknown,delivery:"inline"|"detached"="inline")=>{
      calls.push({threadId,target,delivery});
      return {reviewThreadId:threadId,turn:{id:"review-turn"}};
    },
  }) as unknown as AcpClient;
  const registry={runtimeForSession:(_owner:number,id:string)=>id===sessionId?runtime:undefined} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    const started=await agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"baseBranch",branch:"main"},delivery:"inline",
    }} as never) as {started:boolean;reviewThreadId:string};
    assert.deepEqual(started,{started:true,reviewThreadId:sessionId,turnId:"review-turn"});
    assert.deepEqual(calls,[{threadId:sessionId,target:{type:"baseBranch",branch:"main"},delivery:"inline"}]);
    for(const target of [
      {type:"uncommittedChanges"},
      {type:"commit",sha:"abcdef1234567",title:"Fixture commit"},
      {type:"custom",instructions:"Check for unsafe file handling"},
    ]){
      const result=await agent.executeMobile({op:"reviewThread" as never,userId:101,args:{sessionId,target}} as never) as {started:boolean};
      assert.equal(result.started,true);
    }
    assert.deepEqual(calls.slice(1).map((call)=>call.target),[
      {type:"uncommittedChanges"},
      {type:"commit",sha:"abcdef1234567",title:"Fixture commit"},
      {type:"custom",instructions:"Check for unsafe file handling"},
    ]);
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:202,args:{
      sessionId,target:{type:"uncommittedChanges"},delivery:"inline",
    }} as never),/не разрешён/i);
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"baseBranch",branch:"../outside"},delivery:"inline",
    }} as never),/ветк|цель|review/i);
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"commit",sha:"--all"},delivery:"inline",
    }} as never),/SHA коммита/i);
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"custom",instructions:"x".repeat(1001)},delivery:"inline",
    }} as never),/1000 символов/i);
    runtime.isBusy=true;
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"uncommittedChanges"},delivery:"inline",
    }} as never),/выполняет задачу/i);
    runtime.isBusy=false;
    activeTurn=true;
    await assert.rejects(agent.executeMobile({op:"reviewThread" as never,userId:101,args:{
      sessionId,target:{type:"uncommittedChanges"},delivery:"inline",
    }} as never),/активн|выполняет/i);
    assert.equal(calls.length,4,"invalid, unauthorized, and busy review requests must not reach Codex");
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
    const createdFolder=await agent.executeMobile({op:"createDirectory",userId:101,args:{sessionId,path:"src/new-folder"}}) as {path:string};
    assert.deepEqual(createdFolder,{path:"src/new-folder"});
    assert.equal(statSync(join(project,"src","new-folder")).isDirectory(),true);
    await assert.rejects(agent.executeMobile({op:"createDirectory",userId:101,args:{sessionId,path:"src/new-folder"}}),/уже существует|существует/i);
    await assert.rejects(agent.executeMobile({op:"createDirectory",userId:101,args:{sessionId,path:"../outside"}}),/Недопустимый путь|пределы проекта/i);
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
    await assert.rejects(agent.executeMobile({op:"createDirectory",userId:101,args:{sessionId,path:"src/busy-folder"}}),/текущей задачи/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile rename keeps a project file inside its authorized folder and rejects stale listings",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-rename-file-"));
  const project=join(dir,"project");mkdirSync(join(project,"src"),{recursive:true});
  const file=join(project,"src","main.ts");writeFileSync(file,"export const answer = 42;\n");
  const sessionId="26262626-2626-4262-8262-262626262626";
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Mobile rename",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef03",op:"snapshot",userId:101,args:{}});
    const listing=await agent.executeMobile({op:"files",userId:101,args:{sessionId,path:"src"}}) as {entries:Array<{name:string;size:number;mtimeMs:number}>};
    const entry=listing.entries.find((item)=>item.name==="main.ts")!;
    const renamed=await agent.executeMobile({op:"renameProjectEntry",userId:101,args:{sessionId,path:"src/main.ts",newName:"answer.ts",expectedKind:"file",expectedSize:entry.size,expectedMtimeMs:entry.mtimeMs}});
    assert.deepEqual(renamed,{from:"src/main.ts",path:"src/answer.ts",kind:"file"});
    assert.equal(readFileSync(join(project,"src","answer.ts"),"utf8"),"export const answer = 42;\n");
    const nextListing=await agent.executeMobile({op:"files",userId:101,args:{sessionId,path:"src"}}) as {entries:Array<{name:string;size:number;mtimeMs:number}>};
    const nextEntry=nextListing.entries.find((item)=>item.name==="answer.ts")!;
    writeFileSync(join(project,"src","answer.ts"),"new content with a different length\n");
    await assert.rejects(agent.executeMobile({op:"renameProjectEntry",userId:101,args:{sessionId,path:"src/answer.ts",newName:"stale.ts",expectedKind:"file",expectedSize:nextEntry.size,expectedMtimeMs:nextEntry.mtimeMs}}),/изменился|обновите/i);
    await assert.rejects(agent.executeMobile({op:"renameProjectEntry",userId:202,args:{sessionId,path:"src/answer.ts",newName:"foreign.ts",expectedKind:"file",expectedSize:nextEntry.size,expectedMtimeMs:nextEntry.mtimeMs}}),/Пользователь не разрешён/);
    assert.equal(existsSync(join(project,"src","answer.ts")),true);
    assert.equal(existsSync(join(project,"src","stale.ts")),false);
    const nested=join(project,"nested");mkdirSync(join(nested,"src"),{recursive:true});
    writeFileSync(join(nested,"src","index.ts"),"export {}\n");
    const root=await agent.executeMobile({op:"files",userId:101,args:{sessionId}}) as {entries:Array<{name:string;kind:string;mtimeMs:number}>};
    const directory=root.entries.find((item)=>item.name==="nested")!;
    const renamedDirectory=await agent.executeMobile({op:"renameProjectEntry",userId:101,args:{sessionId,path:"nested",newName:"components",expectedKind:"directory",expectedMtimeMs:directory.mtimeMs}});
    assert.deepEqual(renamedDirectory,{from:"nested",path:"components",kind:"directory"});
    assert.equal(readFileSync(join(project,"components","src","index.ts"),"utf8"),"export {}\n");
    assert.equal(existsSync(nested),false);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile delete removes an owned file and refuses non-empty project folders",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-delete-entry-"));
  const project=join(dir,"project");mkdirSync(join(project,"empty-folder"),{recursive:true});mkdirSync(join(project,"full-folder"),{recursive:true});
  writeFileSync(join(project,"remove.txt"),"remove this file\n");writeFileSync(join(project,"full-folder","keep.txt"),"keep this file\n");
  const sessionId="27272727-2727-4272-8272-272727272727";
  const runtime={sessionId,isBusy:false};
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"project",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Mobile delete",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef04",op:"snapshot",userId:101,args:{}});
    const root=await agent.executeMobile({op:"files",userId:101,args:{sessionId}}) as {entries:Array<{name:string;kind:string;size?:number;mtimeMs:number}>};
    const file=root.entries.find((entry)=>entry.name==="remove.txt")!;
    const removed=await agent.executeMobile({op:"deleteProjectEntry",userId:101,args:{sessionId,path:"remove.txt",expectedKind:"file",expectedSize:file.size,expectedMtimeMs:file.mtimeMs}});
    assert.deepEqual(removed,{path:"remove.txt",kind:"file"});
    assert.equal(existsSync(join(project,"remove.txt")),false);
    const empty=root.entries.find((entry)=>entry.name==="empty-folder")!;
    const removedFolder=await agent.executeMobile({op:"deleteProjectEntry",userId:101,args:{sessionId,path:"empty-folder",expectedKind:"directory",expectedMtimeMs:empty.mtimeMs}});
    assert.deepEqual(removedFolder,{path:"empty-folder",kind:"directory"});
    assert.equal(existsSync(join(project,"empty-folder")),false);
    const full=root.entries.find((entry)=>entry.name==="full-folder")!;
    await assert.rejects(agent.executeMobile({op:"deleteProjectEntry",userId:101,args:{sessionId,path:"full-folder",expectedKind:"directory",expectedMtimeMs:full.mtimeMs}}),/пуст|содержит|не удалось/i);
    await assert.rejects(agent.executeMobile({op:"deleteProjectEntry",userId:202,args:{sessionId,path:"full-folder/keep.txt",expectedKind:"file",expectedSize:14,expectedMtimeMs:full.mtimeMs}}),/Пользователь не разрешён/);
    assert.equal(existsSync(join(project,"full-folder","keep.txt")),true);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile project image reads return bounded raster data and reject SVG or paths outside the session",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-image-"));
  const project=join(dir,"repo"),assets=join(project,"assets");
  mkdirSync(assets,{recursive:true});
  const sessionId="29292929-2929-4929-8929-292929292929";
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=","base64");
  writeFileSync(join(assets,"pixel.png"),png);
  writeFileSync(join(assets,"spoof.png"),"<svg onload=alert(1)></svg>");
  writeFileSync(join(assets,"large.png"),Buffer.alloc(3*1024*1024+1,0));
  writeFileSync(join(assets,"active.svg"),"<svg onload=alert(1)></svg>");
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Image fixture",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const image=await agent.executeMobile({op:"readImage" as never,userId:101,args:{sessionId,path:"assets/pixel.png"}}) as {mime:string;data:string};
    assert.equal(image.mime,"image/png");
    assert.deepEqual(Buffer.from(image.data,"base64"),png);
    await assert.rejects(agent.executeMobile({op:"readImage" as never,userId:101,args:{sessionId,path:"assets/spoof.png"}}),/не соответствует формату/);
    await assert.rejects(agent.executeMobile({op:"readImage" as never,userId:101,args:{sessionId,path:"assets/large.png"}}),/больше 3 МБ/);
    await assert.rejects(agent.executeMobile({op:"readImage" as never,userId:101,args:{sessionId,path:"assets/active.svg"}}),/Неподдерживаемый формат/);
    await assert.rejects(agent.executeMobile({op:"readImage" as never,userId:101,args:{sessionId,path:"..\\outside.png"}}),/относительный|Недопустимый путь|недоступен/);
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

test("mobile conflict-stage reads return bounded UTF-8 base, ours and theirs only for an owned unmerged path",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-conflict-stages-"));
  const project=join(dir,"repo");mkdirSync(project,{recursive:true});
  const git=(...args:string[])=>execFileSync("git",["-C",project,...args],{encoding:"utf8",windowsHide:true});
  const sessionId="31313131-3131-4131-8131-313131313131";
  git("init","-q","-b","main");
  git("config","user.name","Mobile Fixture");git("config","user.email","mobile-fixture@example.invalid");
  mkdirSync(join(project,"src"));writeFileSync(join(project,"src","conflict.ts"),"export const value = 'base';\n");
  git("add","src/conflict.ts");git("commit","-m","base");
  git("switch","-q","-c","theirs");writeFileSync(join(project,"src","conflict.ts"),"export const value = 'theirs';\n");git("commit","-am","theirs");
  git("switch","-q","main");writeFileSync(join(project,"src","conflict.ts"),"export const value = 'ours';\n");git("commit","-am","ours");
  try{git("merge","theirs");}catch{/* Expected: both branches changed the same line. */}
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[{id:sessionId,name:"Conflict fixture",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const stages=await agent.executeMobile({op:"gitConflictStages" as never,userId:101,args:{sessionId,path:"src/conflict.ts"}} as never) as {path:string;base:string;ours:string;theirs:string};
    assert.deepEqual(stages,{project:"Conflict fixture",path:"src/conflict.ts",base:"export const value = 'base';\n",ours:"export const value = 'ours';\n",theirs:"export const value = 'theirs';\n"});
    await assert.rejects(agent.executeMobile({op:"gitConflictStages" as never,userId:101,args:{sessionId:"99999999-9999-4999-8999-999999999999",path:"src/conflict.ts"}} as never),/Доступ к сеансу запрещён/);
    await assert.rejects(agent.executeMobile({op:"gitConflictStages" as never,userId:101,args:{sessionId,path:"..\\outside.txt"}} as never),/Недопустимый путь Git/);
    git("add","src/conflict.ts");
    await assert.rejects(agent.executeMobile({op:"gitConflictStages" as never,userId:101,args:{sessionId,path:"src/conflict.ts"}} as never),/не находится в состоянии конфликта/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile binary Git conflict resolution selects a current regular-file stage and stages it safely",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-binary-conflict-"));
  const project=join(dir,"repo");mkdirSync(project,{recursive:true});
  const git=(...args:string[])=>execFileSync("git",["-C",project,...args],{encoding:"utf8",windowsHide:true});
  const sessionId="41414141-4141-4141-8141-414141414141";
  const file=join(project,"assets","icon.bin");mkdirSync(join(project,"assets"));
  const base=Buffer.from([0,1,2,3]),ours=Buffer.from([0,4,5,6]),theirs=Buffer.from([0,7,8,9]);
  git("init","-q","-b","main");
  git("config","user.name","Mobile Fixture");git("config","user.email","mobile-fixture@example.invalid");
  writeFileSync(file,base);git("add","assets/icon.bin");git("commit","-m","base");
  git("switch","-q","-c","theirs");writeFileSync(file,theirs);git("commit","-am","theirs");
  git("switch","-q","main");writeFileSync(file,ours);git("commit","-am","ours");
  try{git("merge","theirs");}catch{/* Expected: Git cannot merge binary content. */}
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[{id:sessionId,name:"Binary conflict fixture",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef02",op:"snapshot",userId:101,args:{}});
    const currentHash=createHash("sha256").update(readFileSync(file)).digest("hex");
    const stages=await agent.executeMobile({op:"gitConflictStages" as never,userId:101,args:{sessionId,path:"assets/icon.bin"}} as never) as {binaryStages?:string[];worktreeSha256?:string};
    assert.deepEqual(stages.binaryStages,["base","ours","theirs"]);
    assert.equal(stages.worktreeSha256,currentHash);
    await assert.rejects(agent.executeMobile({op:"gitResolveConflictStage" as never,userId:101,args:{sessionId,path:"assets/icon.bin",stage:"theirs",expectedHash:"0".repeat(64)}} as never),/изменился|обновите/i);
    assert.deepEqual(readFileSync(file),ours,"a stale request must not overwrite the current worktree file");
    const resolved=await agent.executeMobile({op:"gitResolveConflictStage" as never,userId:101,args:{sessionId,path:"assets/icon.bin",stage:"theirs",expectedHash:currentHash}} as never) as {path:string;size:number;stage:string};
    assert.deepEqual(resolved,{path:"assets/icon.bin",size:theirs.length,stage:"theirs",sha256:createHash("sha256").update(theirs).digest("hex")});
    assert.deepEqual(readFileSync(file),theirs);
    const status=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {changes:Array<{path:string;indexStatus:string;worktreeStatus:string}>};
    assert.ok(status.changes.some((change)=>change.path==="assets/icon.bin"&&change.indexStatus==="M"&&change.worktreeStatus===" "));
    await assert.rejects(agent.executeMobile({op:"gitResolveConflictStage" as never,userId:202,args:{sessionId,path:"assets/icon.bin",stage:"ours",expectedHash:createHash("sha256").update(theirs).digest("hex")}} as never),/Пользователь не разрешён/);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile Git lists fetched remote branches and tracks only a listed remote ref",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-remote-branch-"));
  const project=join(dir,"repo"),source=join(dir,"source"),remote=join(dir,"origin.git");
  for(const path of [project,source,remote])mkdirSync(path,{recursive:true});
  const git=(cwd:string,...args:string[])=>execFileSync("git",["-C",cwd,...args],{stdio:"ignore",windowsHide:true});
  git(remote,"init","--bare","-q");
  git(source,"init","-b","main","-q");
  git(source,"config","user.name","Mobile Fixture");
  git(source,"config","user.email","mobile-fixture@example.invalid");
  writeFileSync(join(source,"README.md"),"remote branch fixture\n");
  git(source,"add","README.md");
  git(source,"commit","-m","remote branch fixture");
  git(source,"switch","-c","feature/phone");
  git(source,"push",remote,"feature/phone");
  git(project,"init","-b","main","-q");
  git(project,"config","user.name","Mobile Fixture");
  git(project,"config","user.email","mobile-fixture@example.invalid");
  writeFileSync(join(project,"README.md"),"local branch fixture\n");
  git(project,"add","README.md");
  git(project,"commit","-m","local branch fixture");
  git(project,"remote","add","origin",remote);
  git(project,"fetch","origin");
  const sessionId="31313131-3131-4131-8131-313131313131";
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async()=>[{id:sessionId,name:"Remote branch fixture",cwd:project,source:"cli",recencyAt:2}],
    availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const status=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {remoteBranches:string[]};
    assert.deepEqual(status.remoteBranches,["origin/feature/phone"]);
    const tracked=await agent.executeMobile({op:"gitTrackRemoteBranch" as never,userId:101,args:{sessionId,remoteBranch:"origin/feature/phone"}}) as {
      branch:string;upstream:string;
    };
    assert.equal(tracked.branch,"feature/phone");
    assert.equal(tracked.upstream,"origin/feature/phone");
    assert.equal(execFileSync("git",["-C",project,"branch","--show-current"],{encoding:"utf8",windowsHide:true}).trim(),"feature/phone");
    await assert.rejects(agent.executeMobile({op:"gitTrackRemoteBranch" as never,userId:101,args:{sessionId,remoteBranch:"origin/not-fetched"}}),/[Уу]далённая ветка|remote branch/i);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile Git fetches a configured remote and pushes only the current branch after session authorization",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-git-sync-"));
  const project=join(dir,"repo"),source=join(dir,"source"),remote=join(dir,"origin.git");
  for(const path of [project,source,remote])mkdirSync(path,{recursive:true});
  const git=(cwd:string,...args:string[])=>execFileSync("git",["--no-pager","-C",cwd,...args],{stdio:"ignore",windowsHide:true});
  git(remote,"init","--bare","-q");
  git(project,"init","-b","main","-q");
  git(project,"config","user.name","Mobile Fixture");
  git(project,"config","user.email","mobile-fixture@example.invalid");
  writeFileSync(join(project,"README.md"),"base\n");
  git(project,"add","README.md");
  git(project,"commit","-m","base");
  git(project,"remote","add","origin",remote);
  git(project,"push","--set-upstream","origin","main");
  git(remote,"symbolic-ref","HEAD","refs/heads/main");

  execFileSync("git",["clone",remote,source],{stdio:"ignore",windowsHide:true});
  git(source,"config","user.name","Mobile Fixture");
  git(source,"config","user.email","mobile-fixture@example.invalid");
  git(source,"switch","-c","feature/phone");
  writeFileSync(join(source,"phone.txt"),"remote branch\n");
  git(source,"add","phone.txt");
  git(source,"commit","-m","remote feature");
  git(source,"push","origin","feature/phone");

  const sessionId="32323232-3232-4232-8232-323232323232";
  const foreignId="33333333-3333-4333-8333-333333333333";
  const threads=[
    {id:sessionId,name:"Git sync fixture",cwd:project,source:"cli",recencyAt:2},
    {id:foreignId,name:"Foreign fixture",cwd:project,source:"cli",recencyAt:1},
  ];
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],listThreads:async()=>threads,availableModels:[],
  }) as unknown as AcpClient;
  const runtime={sessionId,isBusy:false};
  const registry={controller:()=>({list:()=>[]}),get:()=>runtime,runtimeForSession:()=>runtime} as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const sessions=new TelegramSessionRegistry(dir);
  sessions.record(foreignId,202,project,"private");
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const before=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {remoteBranches:string[]};
    assert.deepEqual(before.remoteBranches,["origin/main"]);
    const fetched=await agent.executeMobile({op:"gitFetch" as never,userId:101,args:{sessionId,remoteName:"origin"}}) as {remoteName:string;fetched:boolean};
    assert.deepEqual(fetched,{remoteName:"origin",fetched:true});
    const after=await agent.executeMobile({op:"gitStatus",userId:101,args:{sessionId}}) as {remoteBranches:string[]};
    assert.deepEqual(after.remoteBranches,["origin/feature/phone","origin/main"]);

    git(project,"switch","-c","mobile/phone");
    writeFileSync(join(project,"phone-local.txt"),"phone commit\n");
    git(project,"add","phone-local.txt");
    git(project,"commit","-m","phone commit");
    const pushed=await agent.executeMobile({op:"gitPush" as never,userId:101,args:{sessionId,remoteName:"origin"}}) as {remoteName:string;branch:string};
    assert.deepEqual(pushed,{remoteName:"origin",branch:"mobile/phone"});
    assert.ok(execFileSync("git",["--git-dir",remote,"show-ref","--verify","refs/heads/mobile/phone"],{encoding:"utf8",windowsHide:true}).trim());
    await assert.rejects(agent.executeMobile({op:"gitPush" as never,userId:101,args:{sessionId:foreignId,remoteName:"origin"}}),/Доступ к сеансу запрещён/);

    const marker=join(dir,"remote-helper-ran.txt");
    git(project,"remote","add","unsafe",`ext::sh -c 'echo blocked > ${marker}'`);
    await assert.rejects(agent.executeMobile({op:"gitFetch" as never,userId:101,args:{sessionId,remoteName:"unsafe"}}),/небезопас|неподдерживаем/i);
    assert.equal(existsSync(marker),false);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});

test("mobile worktree creation builds an isolated Git checkout and starts a thread in the shared ACP runtime",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-worktree-"));
  const project=join(dir,"repo");
  const sessionId="73737373-7373-4737-8737-737373737373";
  const worktreeSessionId="84848484-8484-4484-8484-848484848484";
  mkdirSync(project);
  mkdirSync(join(dir,"data"));
  const git=(...args:string[])=>execFileSync("git",["-C",project,...args],{stdio:"ignore",windowsHide:true});
  git("init","-b","main");
  git("config","user.name","Mobile Fixture");
  git("config","user.email","mobile-fixture@example.invalid");
  writeFileSync(join(project,"README.md"),"initial project state\n");
  git("add","README.md");
  git("commit","-m","initial project state");
  const original={id:sessionId,name:"Main session",cwd:project,source:"cli",createdAt:1,updatedAt:2,recencyAt:2};
  const runtime={sessionId,isBusy:false};
  let startedCwd="";
  let attachedCwd="";
  let rejectNewSession=false;
  const controller={list:()=>[],runtimeForSession:()=>undefined,async addAttach(_id:string,cwd:string){attachedCwd=cwd;}};
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"p1",name:"repo",roots:[project]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:[original],
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],
    currentModelId:"default",currentSubagents:()=>[],accountState:async()=>({}),
    async newSession(cwd:string){startedCwd=cwd;if(rejectNewSession)throw new Error("Codex failed to start");return worktreeSessionId;},
  }) as unknown as AcpClient;
  const registry={
    controller:()=>controller,get:()=>runtime,
    runtimeForSession:(_owner:number,id:string)=>id===sessionId?runtime:undefined,
  } as unknown as RuntimeRegistry;
  const cfg={sessionsDir:dir,dataDir:join(dir,"data"),workspace:project,projectRoots:[project],allowedUsers:new Set(["101"])} as AppConfig;
  const agent=new MiniAppAgent({cfg,acp,registry});
  try{
    await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}});
    const created=await agent.executeMobile({op:"createWorktree",userId:101,args:{sessionId,branchName:"phone/experiment"}}) as {
      sessionId:string;branch:string;path:string;
    };
    assert.equal(created.sessionId,worktreeSessionId);
    assert.equal(created.branch,"phone/experiment");
    assert.equal(startedCwd,created.path);
    assert.notEqual(startedCwd,project);
    const worktreeBranch=execFileSync("git",["-C",project,"worktree","list","--porcelain"],{encoding:"utf8",windowsHide:true});
    assert.match(worktreeBranch,/branch refs\/heads\/phone\/experiment/);
    const next=await agent.execute({id:"abcdef0123456789abcdef02",op:"snapshot",userId:101,args:{}}) as {
      selected:string;sessions:Array<{id:string;cwd:string;title:string}>;
    };
    assert.equal(next.selected,worktreeSessionId);
    assert.equal(next.sessions.find((session)=>session.id===worktreeSessionId)?.cwd,created.path);
    assert.match(next.sessions.find((session)=>session.id===worktreeSessionId)?.title??"",/phone\/experiment/);
    await agent.execute({id:"abcdef0123456789abcdef03",op:"select",userId:101,args:{sessionId:worktreeSessionId}});
    assert.equal(attachedCwd,created.path,"the new thread can attach through the existing runtime controller");
    await assert.rejects(agent.executeMobile({op:"createWorktree",userId:101,args:{sessionId,branchName:"../../outside"}}),/имя ветки|ветка/i);
    await assert.rejects(agent.executeMobile({op:"createWorktree",userId:202,args:{sessionId,branchName:"phone/other"}}),/не разрешён/i);
    rejectNewSession=true;
    await assert.rejects(agent.executeMobile({op:"createWorktree",userId:101,args:{sessionId,branchName:"phone/failure"}}),/Codex failed to start/);
    const remainingWorktrees=execFileSync("git",["-C",project,"worktree","list","--porcelain"],{encoding:"utf8",windowsHide:true});
    assert.doesNotMatch(remainingWorktrees,/phone\/failure/);
    const remainingBranch=execFileSync("git",["-C",project,"branch","--list","phone/failure"],{encoding:"utf8",windowsHide:true});
    assert.equal(remainingBranch.trim(),"");
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

test("mobile section management uses Codex metadata APIs and cannot move a foreign session",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-mobile-sections-"));
  const sessionId="abcdefab-cdef-4abc-8def-abcdefabcdef";
  const foreignId="12345678-1234-4234-8234-123456789abc";
  const sections=[{id:"section-1",name:"Inbox"}];
  let sectionListFails=false;
  const moved:Array<{threadId:string;sectionId:string|null}>=[];
  const threads=[
    {id:sessionId,name:"Owned",cwd:dir,source:"appServer",createdAt:1,updatedAt:2,recencyAt:2,section:sections[0]},
    {id:foreignId,name:"Private",cwd:dir,source:"appServer",createdAt:1,updatedAt:1,recencyAt:1},
  ];
  const acp=Object.assign(new EventEmitter(),{
    isConnected:true,
    listProjects:async()=>[{id:"project",name:"Fixture",roots:[dir]}],
    listThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    listAllThreads:async(params?:{archived?:boolean})=>params?.archived?[]:threads,
    async listThreadSections(){if(sectionListFails)throw new Error("Method not found");return sections.map((section)=>({...section}));},
    async createThreadSection(name:string){const section={id:"section-2",name};sections.push(section);return section;},
    async renameThreadSection(sectionId:string,name:string){const section=sections.find((item)=>item.id===sectionId);if(!section)throw new Error("section missing");section.name=name;return {...section};},
    async deleteThreadSection(sectionId:string){const index=sections.findIndex((item)=>item.id===sectionId);if(index<0)throw new Error("section missing");sections.splice(index,1);},
    async moveThreadToSection(threadId:string,sectionId:string|null){moved.push({threadId,sectionId});const thread=threads.find((item)=>item.id===threadId);if(thread)thread.section=sectionId===CODEX_PINNED_THREAD_SECTION_ID?{id:CODEX_PINNED_THREAD_SECTION_ID,name:"Pinned"}:sectionId?sections.find((item)=>item.id===sectionId):undefined;},
    availableModels:[],availableModes:[],availableSkills:[],availableMcpServers:[],currentModelId:"default",currentModeId:"code",
  }) as unknown as AcpClient;
  const cfg={sessionsDir:dir,dataDir:dir,workspace:dir,projectRoots:[dir],allowedUsers:new Set(["101"])} as AppConfig;
  const owners=new TelegramSessionRegistry(dir);
  owners.record(sessionId,101,dir,"Fixture");
  owners.record(foreignId,202,dir,"Fixture");
  const agent=new MiniAppAgent({cfg,acp,registry:{get:()=>({sessionId:""}),runtimeForSession:()=>undefined,controller:()=>({list:()=>[]})} as unknown as RuntimeRegistry});
  const perform=(op:string,userId:number,args:Record<string,unknown>={})=>agent.executeMobile({op,userId,args} as never);
  try{
    const initial=await agent.execute({id:"abcdef0123456789abcdef01",op:"snapshot",userId:101,args:{}}) as {sections:Array<{id:string;name:string;builtIn?:boolean}>;sectionsAvailable:boolean};
    assert.equal(initial.sectionsAvailable,true);
    assert.deepEqual(initial.sections[0],{id:CODEX_PINNED_THREAD_SECTION_ID,name:"Закреплённые",builtIn:true});
    assert.deepEqual(await perform("listThreadSections",101),[{id:"section-1",name:"Inbox"}]);
    const created=await perform("createThreadSection",101,{name:"  Review  "}) as {id:string;name:string};
    assert.deepEqual(created,{id:"section-2",name:"Review"});
    const renamed=await perform("renameThreadSection",101,{sectionId:created.id,name:"Ship"}) as {id:string;name:string};
    assert.deepEqual(renamed,{id:"section-2",name:"Ship"});
    assert.deepEqual(await perform("moveThreadToSection",101,{sessionId,sectionId:created.id}),{sessionId,sectionId:created.id,pinned:false});
    assert.deepEqual(moved,[{threadId:sessionId,sectionId:created.id}]);
    assert.deepEqual(await perform("moveThreadToSection",101,{sessionId,sectionId:CODEX_PINNED_THREAD_SECTION_ID}),{sessionId,sectionId:CODEX_PINNED_THREAD_SECTION_ID,pinned:true});
    assert.deepEqual(moved[1],{threadId:sessionId,sectionId:CODEX_PINNED_THREAD_SECTION_ID});
    const pinnedSnapshot=await agent.execute({id:"abcdef0123456789abcdef02",op:"snapshot",userId:101,args:{}}) as {sessions:Array<{id:string;section?:{id:string;name:string;builtIn?:boolean}} >};
    assert.deepEqual(pinnedSnapshot.sessions.find((item)=>item.id===sessionId)?.section,{id:CODEX_PINNED_THREAD_SECTION_ID,name:"Закреплённые",builtIn:true});
    await assert.rejects(perform("renameThreadSection",101,{sectionId:CODEX_PINNED_THREAD_SECTION_ID,name:"Fake pinned"}),/нельзя переименовать/i);
    await assert.rejects(perform("deleteThreadSection",101,{sectionId:CODEX_PINNED_THREAD_SECTION_ID}),/нельзя удалить/i);
    await assert.rejects(perform("moveThreadToSection",101,{sessionId:foreignId,sectionId:created.id}),/Доступ к переписке запрещён|не найдена/i);
    await assert.rejects(perform("moveThreadToSection",202,{sessionId,sectionId:created.id}),/не разрешён/i);
    await assert.rejects(perform("createThreadSection",101,{name:"\u0001bad"}),/название раздела/i);
    await assert.rejects(perform("moveThreadToSection",101,{sessionId,sectionId:"missing-section"}),/раздел не найден/i);
    await perform("moveThreadToSection",101,{sessionId,sectionId:null});
    await perform("deleteThreadSection",101,{sectionId:created.id});
    assert.deepEqual(sections,[{id:"section-1",name:"Inbox"}]);
    sectionListFails=true;
    const unsupported=await agent.execute({id:"abcdef0123456789abcdef03",op:"snapshot",userId:101,args:{}}) as {sections:Array<unknown>;sectionsAvailable:boolean};
    assert.equal(unsupported.sectionsAvailable,false);
    assert.deepEqual(unsupported.sections,[]);
  }finally{agent.stop();rmSync(dir,{recursive:true,force:true});}
});
