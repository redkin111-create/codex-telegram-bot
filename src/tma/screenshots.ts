/**
 * Incremental screenshot index for Codex Desktop and bot sessions.
 *
 * The old Mini App re-scanned only the last 2 MiB of JSONL when asking for a
 * screenshot. Large later tool results dropped the reference, even if the
 * image was still present. This index remembers bounded references while it
 * follows new records. It never sends file data or untrusted tool output.
 */
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import { watchImagePathsFromEvents } from "../bot/watch-images.js";

export interface ScreenshotRef {
  path:string;
  name:string;
  mtimeMs:number;
  size:number;
}
type Cursor={path:string;cwd:string;offset:number;partial:string;references:string[];images:ScreenshotRef[]};
const MAX_SCAN=8*1024*1024;
const MAX_LINE=4*1024*1024;
const MAX_REFERENCES=64;
const MAX_IMAGES=24;
const MAX_BYTES=3*1024*1024;
const EXTENSIONS=new Set([".png",".jpg",".jpeg",".webp",".gif"]);

export class TmaScreenshotIndex {
  private readonly sessions=new Map<string,Cursor>();
  private readonly pending=new Map<string,Promise<ScreenshotRef[]>>();

  async scan(id:string,jsonl:string,cwd:string):Promise<ScreenshotRef[]> {
    const running=this.pending.get(id);
    if(running)return running;
    const promise=this.scanOnce(id,jsonl,cwd);
    this.pending.set(id,promise);
    try{return await promise;}
    finally{if(this.pending.get(id)===promise)this.pending.delete(id);}
  }

  private async scanOnce(id:string,jsonl:string,cwd:string):Promise<ScreenshotRef[]>{
    let fileSize=0;
    try{fileSize=(await stat(jsonl)).size;}catch{return [];}
    let current=this.sessions.get(id);
    if(!current||current.path!==jsonl||current.cwd!==cwd||current.offset>fileSize){
      const from=Math.max(0,fileSize-MAX_SCAN);
      current={path:jsonl,cwd,offset:from,partial:"",references:[],images:[]};
      // If starting mid-line, discard its tail: JSONL records are atomic.
      if(from>0)current.partial="\0";
      this.sessions.delete(id);this.sessions.set(id,current);
      if(this.sessions.size>60)this.sessions.delete(this.sessions.keys().next().value!);
    }
    if(current.offset<fileSize){
      const remaining=Math.min(MAX_SCAN,fileSize-current.offset);
      const buf=Buffer.allocUnsafe(remaining);
      const handle=await open(jsonl,"r");
      let count=0;
      try{
        while(count<remaining){
          const read=await handle.read(buf,count,remaining-count,current.offset+count);
          if(!read.bytesRead)break;
          count+=read.bytesRead;
        }
      }finally{await handle.close();}
      current.offset+=count;
      let raw=current.partial+buf.toString("utf8",0,count);
      // Huge unfinished tool output must not exhaust browser/bot memory.
      if(raw.length>MAX_LINE*2){
        raw=raw.slice(-MAX_LINE);
        if(!raw.includes("\n"))raw="\0";
      }
      const parts=raw.split("\n");
      current.partial=parts.pop()??"";
      if(current.partial.length>MAX_LINE)current.partial="\0";
      if(parts.length){
        if(parts[0]?.startsWith("\0"))parts.shift();
        // Never allow a single enormous event to monopolize the bot.
        const references=watchImagePathsFromEvents(parts.filter(x=>x.length<MAX_LINE),cwd);
        for(const candidate of references){
          if(!current.references.includes(candidate))current.references.push(candidate);
        }
        if(current.references.length>MAX_REFERENCES)current.references.splice(0,current.references.length-MAX_REFERENCES);
      }
    }
    // Some Codex tools announce the file BEFORE the browser finishes writing.
    // Keep the reference and retry validating it on subsequent activity polls.
    let canonicalRoot:string;
    try{canonicalRoot=await realpath(cwd);}catch{return [];}
    const images:ScreenshotRef[]=[];
    for(const candidate of current.references){
      if(!EXTENSIONS.has(extname(candidate).toLowerCase()))continue;
      try{
        const actual=await realpath(candidate);
        const rel=relative(canonicalRoot,actual);
        if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel))continue;
        const meta=await stat(actual);
        if(!meta.isFile()||meta.size<8||meta.size>MAX_BYTES)continue;
        images.push({path:candidate,name:basename(actual),mtimeMs:meta.mtimeMs,size:meta.size});
      }catch{/* not written yet, inaccessible or unsafe */}
    }
    current.images=images.slice(-MAX_IMAGES);
    return [...current.images];
  }

  async authorized(id:string,jsonl:string,cwd:string,path:string):Promise<ScreenshotRef|undefined>{
    const images=await this.scan(id,jsonl,cwd);
    return images.find(img=>img.path===path);
  }
}
