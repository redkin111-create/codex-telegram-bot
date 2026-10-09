/**
 * Crash-safe Mini App prompt journal.
 *
 * Reserve BEFORE invoking Codex. If the bot crashes between dispatch and
 * acknowledgement, this record is intentionally ambiguous, not auto-replayed.
 * That favors preventing duplicate file edits and purchases over automatic
 * retry. No prompt text, images or tokens are stored on disk.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type State="reserved"|"completed"|"uncertain";
type Entry={fingerprint:string;state:State;at:number;result?:unknown};
type FileState={version:1;records:Record<string,Entry>};
const MAX_RECORDS=2000;
const AGE_MS=30*24*60*60*1000;
const UNKNOWN_MESSAGE=
  "Статус предыдущей отправки неизвестен после перезапуска бота. Проверь историю Codex и очередь перед созданием нового задания. Повтор автоматически заблокирован.";

export class DurablePromptJournal {
  private readonly path:string;
  private records:Record<string,Entry>={};

  constructor(dataDir:string){
    mkdirSync(dataDir,{recursive:true});
    this.path=join(dataDir,"tma-prompt-journal.json");
    try{
      const file=JSON.parse(readFileSync(this.path,"utf8")) as Partial<FileState>;
      if(file.version!==1||!file.records||typeof file.records!=="object"||Array.isArray(file.records)){
        throw new Error("Unknown journal format");
      }
      for(const [key,entry] of Object.entries(file.records)){
        if(!entry||typeof entry!=="object"||typeof entry.fingerprint!=="string"||
           !/^[0-9a-f]{64}$/.test(entry.fingerprint)||
           !["reserved","completed","uncertain"].includes(entry.state)||
           !Number.isFinite(entry.at)){
          throw new Error("Corrupt journal entry");
        }
        this.records[key]=entry;
      }
    }catch(err){
      if((err as NodeJS.ErrnoException).code!=="ENOENT"){
        // Fail closed: overwriting a corrupt journal could resend already
        // executed commands. Fix the journal from a backup first.
        throw new Error("Журнал отправок повреждён — отправка заблокирована до восстановления файла", {cause:err});
      }
    }
    this.prune();
  }

  lookup(key:string,fingerprint:string):{found:boolean;result?:unknown}{
    const record=this.records[key];
    if(!record)return {found:false};
    if(record.fingerprint!==fingerprint)throw new Error("ID задания уже использован для другого содержимого");
    if(record.state!=="completed")throw new Error(UNKNOWN_MESSAGE);
    return {found:true,result:record.result};
  }

  reserve(key:string,fingerprint:string):void{
    if(this.records[key])throw new Error("Задание уже записано в журнал");
    this.prune();
    if(Object.keys(this.records).length>=MAX_RECORDS)throw new Error("Журнал отправок заполнен. Требуется проверка истории.");
    this.records[key]={fingerprint,state:"reserved",at:Date.now()};
    this.write();
  }

  complete(key:string,result:unknown):void{
    const record=this.records[key];
    if(!record)return;
    record.state="completed";record.result=result;record.at=Date.now();
    this.write();
  }

  uncertain(key:string):void{
    const record=this.records[key];
    if(!record)return;
    record.state="uncertain";record.at=Date.now();
    this.write();
  }

  clearBeforeDispatch(key:string):void{
    delete this.records[key];
    this.write();
  }

  summary():{reserved:number;uncertain:number;completed:number}{
    const counts={reserved:0,uncertain:0,completed:0};
    for(const record of Object.values(this.records))counts[record.state]++;
    return counts;
  }

  private prune():void{
    const now=Date.now();
    for(const [key,entry] of Object.entries(this.records)){
      // Never prune a pending/uncertain entry just to free space; this could
      // turn a resend of the same request into another execution.
      if(entry.state==="completed"&&now-entry.at>AGE_MS)delete this.records[key];
    }
    const completed=Object.entries(this.records).filter(([,r])=>r.state==="completed")
      .sort((a,b)=>a[1].at-b[1].at);
    const remove=Math.max(0,Object.keys(this.records).length-MAX_RECORDS+1);
    for(let i=0;i<Math.min(remove,completed.length);i++)delete this.records[completed[i]![0]];
  }

  private write():void{
    const temp=this.path+"."+process.pid+"."+randomBytes(4).toString("hex")+".tmp";
    try{
      writeFileSync(temp,JSON.stringify({version:1,records:this.records} satisfies FileState),{
        encoding:"utf8",mode:0o600,flag:"wx",
      });
      renameSync(temp,this.path);
    }catch(error){
      try{unlinkSync(temp);}catch{ /* no tmp */ }
      throw error;
    }
  }
}
