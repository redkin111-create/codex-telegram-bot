import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePausePath, vbsLauncher } from "../src/service/windows.js";
import type { LaunchSpec } from "../src/service/types.js";

test("Windows watchdog blocks intentional stops and restarts only crashed Node processes with backoff",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tma-win-recovery-"));
  try{
    const spec:LaunchSpec={
      id:"codex-telegram-bot",displayName:"Codex Telegram Bot",
      nodePath:"C:\\Program Files\\nodejs\\node.exe",
      codexCliPath:"C:\\Program Files\\Codex\\codex.exe",
      args:["--import","tsx","C:\\codex-tg\\src\\index.ts"],
      cwd:"C:\\codex-tg",logsDir:dir,logFile:join(dir,"bot.log"),
    };
    const vbs=vbsLauncher(spec);
    assert.match(vbs,/Do While Not fs\.FileExists\(pauseFile\)/);
    assert.match(vbs,/exitCode = sh\.Run\(.+, 0, True\)/);
    assert.match(vbs,/If fs\.FileExists\(pauseFile\) Then Exit Do/);
    assert.match(vbs,/If exitCode = 0 Then Exit Do/);
    assert.match(vbs,/WScript\.Sleep delayMs/);
    assert.match(vbs,/If delayMs > 60000 Then delayMs = 60000/);
    assert.match(vbs,/CODEX_TG_SUPERVISED/);
    assert.equal(servicePausePath(spec),join(dir,"service.paused"));
    assert(vbs.includes('pauseFile = "'+servicePausePath(spec)+'"'));
    assert(vbs.includes('eventsFile = "'+join(dir,"watchdog-events.log")+'"'));
    assert(vbs.includes('""C:\\Program Files\\nodejs\\node.exe""'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
