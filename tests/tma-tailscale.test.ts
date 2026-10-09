import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import { autoTailscaleFunnel, startLocalTma } from "../src/tma/local.js";
import {
  ensureTailscaleFunnel,
  funnelUrlForPort,
  getFunnelPublicUrl,
  tailscaleDnsName,
  type TailscaleCommand,
} from "../src/tma/tailscale.js";

const name = "codex-laptop.test-tailnet.ts.net";
const status = () => JSON.stringify({
  BackendState: "Running", Self: { DNSName: name + ".", Online: true },
});
const published = (port: number) =>
  "Available on the internet:\nhttps://" + name + "\n|-- / proxy http://127.0.0.1:" + port + "\n";

test("Tailscale DNS name is accepted only for a running authenticated tailnet", () => {
  assert.equal(tailscaleDnsName(status()), name);
  assert.equal(tailscaleDnsName("unparsable"), undefined);
  assert.equal(tailscaleDnsName(JSON.stringify({ BackendState:"Stopped",Self:{DNSName:name} })),undefined);
  assert.equal(tailscaleDnsName(JSON.stringify({ BackendState:"Running",Self:{DNSName:"evil.example.com"} })),undefined);
  assert.equal(tailscaleDnsName(JSON.stringify({ BackendState:"Running",Self:{DNSName:name, Online:false} })),undefined);
});

test("Only a Funnel pointing to this exact local TMA port yields a public URL", () => {
  assert.equal(funnelUrlForPort(published(3301),name,3301),"https://"+name);
  assert.equal(funnelUrlForPort(published(3200),name,3301),undefined);
  assert.equal(funnelUrlForPort(published(3301),"different.ts.net",3301),undefined);
  assert.equal(funnelUrlForPort("No serve config",name,3301),undefined);
});

test("Tailscale background Funnel enablement is idempotent and never overwrites another route",async()=>{
  const args: string[][] = [];
  let active=false;
  const command:TailscaleCommand=async parts=>{
    args.push([...parts]);
    if(parts.join(" ")==="status --json")return status();
    if(parts.join(" ")==="funnel status")return active?published(3301):"No serve config";
    if(parts[0]==="funnel"&&parts.includes("--bg")){active=true;return"";}
    throw Error("Unexpected invocation");
  };
  assert.equal(await ensureTailscaleFunnel(3301,command),"https://"+name);
  assert(args.some(p=>p.join(" ")==="funnel --bg --yes --https=443 http://127.0.0.1:3301"));
  const count=args.length;
  assert.equal(await ensureTailscaleFunnel(3301,command),"https://"+name);
  assert.equal(args.length,count+2,"already published: only check status, do not reconfigure");
  assert.equal(await getFunnelPublicUrl(3301,command),"https://"+name);
  const wrong:TailscaleCommand=async parts=>
    parts.join(" ")==="status --json"?status():published(9000);
  await assert.rejects(ensureTailscaleFunnel(3301,wrong),/другой сервис/);
});

test("TMA_TAILSCALE_AUTO must be explicitly enabled before internet publication",()=>{
  assert.equal(autoTailscaleFunnel({}),false);
  assert.equal(autoTailscaleFunnel({TMA_LOCAL:"true"}),false);
  assert.equal(autoTailscaleFunnel({TMA_TAILSCALE_AUTO:"TRUE"}),true);
  assert.equal(autoTailscaleFunnel({TMA_TAILSCALE_AUTO:"false"}),false);
});

test("The same local bot service reconnects a delayed Tailscale daemon without a VPS",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-tailscale-local-"));
  const cwd=join(dir,"workspace");
  const cfg={
    token:"test:bot-token",allowedUsers:new Set(["101"]),dataDir:dir,
    sessionsDir:dir,workspace:cwd,projectRoots:[cwd],
  } as AppConfig;
  const acp=Object.assign(new EventEmitter(),{
    listProjects:async()=>[],listThreads:async()=>[],
    availableModels:[],currentModelId:"test",
  }) as unknown as AcpClient;
  const registry={
    controller:()=>({list:()=>[]}), get:()=>({sessionId:"none"}),
  } as unknown as RuntimeRegistry;
  let attempts=0,mappedPort:number|undefined;
  const command:TailscaleCommand=async args=>{
    if(args.join(" ")==="status --json"){
      if(++attempts===1)throw Error("Tailscale daemon not yet online");
      return status();
    }
    if(args.join(" ")==="funnel status")return mappedPort?published(mappedPort):"No serve config";
    if(args[0]==="funnel"&&args.includes("--bg")){
      const match=args.at(-1)?.match(/^http:\/\/127\.0\.0\.1:(\d+)$/);
      assert(match);
      mappedPort=Number(match[1]);
      return "";
    }
    throw Error("Unexpected command");
  };
  const svc=await startLocalTma(cfg,acp,registry,{
    port:0,startFunnel:true,tailscaleCommand:command,retryDelayMs:5,
  });
  try{
    const url=await Promise.race([
      svc.tunnelReady,
      new Promise<undefined>((_,reject)=>setTimeout(()=>reject(new Error("Timed out")),1500)),
    ]);
    assert.equal(url,"https://"+name);
    assert(attempts>=2);
    assert.equal(mappedPort,Number(new URL(svc.origin).port));
    assert.equal((await fetch(svc.origin+"/")).status,200);
  }finally{
    await svc.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
