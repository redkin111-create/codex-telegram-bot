/**
 * Incremental screenshot index for Codex Desktop and bot sessions.
 *
 * The old Mini App re-scanned only the last 2 MiB of JSONL when asking for a
 * screenshot. Large later tool results dropped the reference, even if the
 * image was still present. This index reads large rollouts in bounded chunks,
 * remembers recent references while it follows new records, and never sends
 * file data or untrusted tool output.
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
const MAX_REFERENCES=256;
const MAX_IMAGES=MAX_REFERENCES;
const OLDER_PAGE_SIZE=80;
const OLDER_CHUNK_SIZE=256*1024;
const MAX_BYTES=3*1024*1024;
const EXTENSIONS=new Set([".png",".jpg",".jpeg",".webp",".gif"]);

export interface ScreenshotPage {
  images:ScreenshotRef[];
  nextCursor?:number;
}

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
      current={path:jsonl,cwd,offset:0,partial:"",references:[],images:[]};
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

  /** Return an older, workspace-validated page without retaining an unbounded index. */
  async olderPage(id:string,jsonl:string,cwd:string,beforeOffset?:number):Promise<ScreenshotPage>{
    let fileSize:number;
    try{fileSize=(await stat(jsonl)).size;}catch{return {images:[]};}
    const limit=beforeOffset??fileSize;
    if(!Number.isSafeInteger(limit)||limit<0||limit>fileSize)throw new Error("Некорректный указатель страницы скриншотов");
    if(limit===0)return {images:[]};

    const recent=await this.scan(id,jsonl,cwd);
    const known=new Set(recent.map(image=>image.path));
    const groups:Array<{offset:number;paths:string[]}>=[];
    const retained=new Set<string>();
    let retainedCount=0;
    let hasEarlier=false;
    const addLine=(line:Buffer,offset:number)=>{
      if(line.length===0||line.length>MAX_LINE)return;
      const paths=watchImagePathsFromEvents([line.toString("utf8")],cwd)
        .filter(path=>EXTENSIONS.has(extname(path).toLowerCase())&&!known.has(path)&&!retained.has(path))
        .slice(-OLDER_PAGE_SIZE);
      if(paths.length===0)return;
      groups.push({offset,paths});
      for(const path of paths)retained.add(path);
      retainedCount+=paths.length;
      while(retainedCount>OLDER_PAGE_SIZE&&groups.length>1){
        const oldest=groups.shift()!;
        retainedCount-=oldest.paths.length;
        for(const path of oldest.paths)retained.delete(path);
        hasEarlier=true;
      }
    };

    const handle=await open(jsonl,"r");
    let readOffset=0;
    let pending=Buffer.alloc(0);
    let pendingOffset=0;
    let droppingLongLine=false;
    try{
      while(readOffset<limit){
        const chunkOffset=readOffset;
        const length=Math.min(OLDER_CHUNK_SIZE,limit-readOffset);
        const chunk=Buffer.allocUnsafe(length);
        let count=0;
        while(count<length){
          const result=await handle.read(chunk,count,length-count,chunkOffset+count);
          if(!result.bytesRead)break;
          count+=result.bytesRead;
        }
        if(count===0)break;
        readOffset+=count;
        const validChunk=chunk.subarray(0,count);
        let raw:Buffer;
        let origin:number;
        if(droppingLongLine){
          const newline=validChunk.indexOf(10);
          if(newline<0)continue;
          droppingLongLine=false;
          raw=validChunk.subarray(newline+1);
          origin=chunkOffset+newline+1;
        }else{
          raw=pending.length?Buffer.concat([pending,validChunk]):validChunk;
          origin=pending.length?pendingOffset:chunkOffset;
        }
        pending=Buffer.alloc(0);
        let start=0;
        for(let newline=raw.indexOf(10);newline>=0;newline=raw.indexOf(10,start)){
          addLine(raw.subarray(start,newline),origin+start);
          start=newline+1;
        }
        const rest=raw.subarray(start);
        if(rest.length>MAX_LINE)droppingLongLine=true;
        else if(rest.length){pending=Buffer.from(rest);pendingOffset=origin+start;}
      }
      if(limit===fileSize&&!droppingLongLine&&pending.length>0)addLine(pending,pendingOffset);
    }finally{await handle.close();}

    const images=await this.validate(groups.flatMap(group=>group.paths),cwd);
    const orderedPaths=new Set(groups.flatMap(group=>group.paths));
    const ordered=images.filter(image=>orderedPaths.has(image.path));
    return {images:ordered,...(hasEarlier&&groups.length?{nextCursor:groups[0]!.offset}:{})};
  }

  private async validate(candidates:string[],cwd:string):Promise<ScreenshotRef[]>{
    let canonicalRoot:string;
    try{canonicalRoot=await realpath(cwd);}catch{return [];}
    const images:ScreenshotRef[]=[];
    for(const candidate of candidates){
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
    return images;
  }
}
