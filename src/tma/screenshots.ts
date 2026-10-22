/**
 * Incremental screenshot index for Codex Desktop and bot sessions.
 *
 * The old Mini App re-scanned only the last 2 MiB of JSONL when asking for a
 * screenshot. Large later tool results dropped the reference, even if the
 * image was still present. This index reads large rollouts in bounded chunks,
 * remembers recent references while it follows new records, and never sends
 * file data or untrusted tool output.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, normalize, relative, sep } from "node:path";
import { watchImagePathsFromEvents } from "../bot/watch-images.js";

export interface ScreenshotRef {
  path:string;
  name:string;
  mtimeMs:number;
  size:number;
}
type Cursor={path:string;cwd:string;endByteOffset?:number;offset:number;partial:string;references:string[];images:ScreenshotRef[]};
const MAX_SCAN=8*1024*1024;
const MAX_LINE=4*1024*1024;
const MAX_REFERENCES=256;
const MAX_IMAGES=MAX_REFERENCES;
const OLDER_PAGE_SIZE=80;
const OLDER_CHUNK_SIZE=256*1024;
const MAX_BYTES=3*1024*1024;
const EXTENSIONS=new Set([".png",".jpg",".jpeg",".webp",".gif"]);
const BSK_SCREENSHOT_NAME=/^bsk-screenshot-[a-z0-9-]+\.png$/i;
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);

function isWithin(root:string,candidate:string):boolean{
  const rel=relative(root,candidate);
  return rel!==""&&rel!==".."&&!rel.startsWith(".."+sep)&&!isAbsolute(rel);
}

async function hasPngSignature(path:string):Promise<boolean>{
  const file=await open(path,"r");
  try{
    const header=Buffer.alloc(PNG_SIGNATURE.length);
    const {bytesRead}=await file.read(header,0,header.length,0);
    return bytesRead===header.length&&header.equals(PNG_SIGNATURE);
  }finally{await file.close();}
}

function pathIdentity(path:string):string{
  const normalized=normalize(path);
  return process.platform==="win32"?normalized.toLocaleLowerCase("en-US"):normalized;
}

export interface ScreenshotPage {
  images:ScreenshotRef[];
  nextCursor?:number;
}

export class TmaScreenshotIndex {
  private readonly sessions=new Map<string,Cursor>();
  private readonly pending=new Map<string,Promise<ScreenshotRef[]>>();

  async scan(id:string,jsonl:string,cwd:string,allowBrowserTemp=false,endByteOffset?:number):Promise<ScreenshotRef[]> {
    const pendingKey=id+(allowBrowserTemp?":mobile":":tma")+(endByteOffset===undefined?":full":`:end:${endByteOffset}`);
    const running=this.pending.get(pendingKey);
    if(running)return running;
    const promise=this.scanOnce(id,jsonl,cwd,allowBrowserTemp,endByteOffset);
    this.pending.set(pendingKey,promise);
    try{return await promise;}
    finally{if(this.pending.get(pendingKey)===promise)this.pending.delete(pendingKey);}
  }

  private async scanOnce(id:string,jsonl:string,cwd:string,allowBrowserTemp:boolean,endByteOffset?:number):Promise<ScreenshotRef[]>{
    let actualSize=0;
    try{actualSize=(await stat(jsonl)).size;}catch{return [];}
    if(endByteOffset!==undefined&&(!Number.isSafeInteger(endByteOffset)||endByteOffset<0))throw new Error("Некорректная граница истории скриншотов");
    const fileSize=endByteOffset===undefined?actualSize:Math.min(actualSize,endByteOffset);
    const cursorId=id+(endByteOffset===undefined?":full":`:end:${endByteOffset}`);
    let current=this.sessions.get(cursorId);
    if(!current||current.path!==jsonl||current.cwd!==cwd||current.endByteOffset!==endByteOffset||current.offset>fileSize){
      current={path:jsonl,cwd,endByteOffset,offset:0,partial:"",references:[],images:[]};
      this.sessions.delete(cursorId);this.sessions.set(cursorId,current);
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
        const known=new Set(current.references.map(pathIdentity));
        for(const candidate of references){
          const identity=pathIdentity(candidate);
          if(!known.has(identity)){
            current.references.push(candidate);
            known.add(identity);
          }
        }
        if(current.references.length>MAX_REFERENCES)current.references.splice(0,current.references.length-MAX_REFERENCES);
      }
    }
    // Some Codex tools announce the file BEFORE the browser finishes writing.
    // Keep the reference and retry validating it on subsequent activity polls.
    const images=await this.validate(current.references,cwd,allowBrowserTemp);
    current.images=images.slice(-MAX_IMAGES);
    return [...current.images];
  }

  async authorized(id:string,jsonl:string,cwd:string,path:string,allowBrowserTemp=false,endByteOffset?:number):Promise<ScreenshotRef|undefined>{
    const images=await this.scan(id,jsonl,cwd,allowBrowserTemp,endByteOffset);
    const identity=pathIdentity(path);
    const recent=images.find(img=>pathIdentity(img.path)===identity);
    if(recent)return recent;
    if(!await this.referencedInRollout(jsonl,cwd,path,endByteOffset))return undefined;
    return (await this.validate([path],cwd,allowBrowserTemp))[0];
  }

  private async referencedInRollout(jsonl:string,cwd:string,path:string,endByteOffset?:number):Promise<boolean>{
    let actualSize:number;
    try{actualSize=(await stat(jsonl)).size;}catch{return false;}
    const limit=endByteOffset===undefined?actualSize:Math.min(actualSize,endByteOffset);
    if(limit<=0)return false;
    const input=createReadStream(jsonl,{start:0,end:limit-1,highWaterMark:64*1024});
    const lines=createInterface({input,crlfDelay:Infinity});
    const identity=pathIdentity(path);
    try{
      for await(const line of lines){
        if(line.length>MAX_LINE)continue;
        if(watchImagePathsFromEvents([line],cwd).some(candidate=>pathIdentity(candidate)===identity))return true;
      }
      return false;
    }catch{return false;}
    finally{input.destroy();}
  }

  /** Return older authorized images without retaining an unbounded index. */
  async olderPage(id:string,jsonl:string,cwd:string,beforeOffset?:number,allowBrowserTemp=false,endByteOffset?:number):Promise<ScreenshotPage>{
    let actualSize:number;
    try{actualSize=(await stat(jsonl)).size;}catch{return {images:[]};}
    if(endByteOffset!==undefined&&(!Number.isSafeInteger(endByteOffset)||endByteOffset<0))throw new Error("Некорректная граница истории скриншотов");
    const fileSize=endByteOffset===undefined?actualSize:Math.min(actualSize,endByteOffset);
    const limit=beforeOffset??fileSize;
    if(!Number.isSafeInteger(limit)||limit<0||limit>fileSize)throw new Error("Некорректный указатель страницы скриншотов");
    if(limit===0)return {images:[]};

    const recent=await this.scan(id,jsonl,cwd,allowBrowserTemp,endByteOffset);
    const known=new Set(recent.map(image=>pathIdentity(image.path)));
    const groups:Array<{offset:number;paths:string[]}>=[];
    const retained=new Set<string>();
    let retainedCount=0;
    let hasEarlier=false;
    const addLine=(line:Buffer,offset:number)=>{
      if(line.length===0||line.length>MAX_LINE)return;
      const paths=watchImagePathsFromEvents([line.toString("utf8")],cwd)
        .filter(path=>EXTENSIONS.has(extname(path).toLowerCase())&&!known.has(pathIdentity(path))&&!retained.has(pathIdentity(path)))
        .slice(-OLDER_PAGE_SIZE);
      if(paths.length===0)return;
      groups.push({offset,paths});
      for(const path of paths)retained.add(pathIdentity(path));
      retainedCount+=paths.length;
      while(retainedCount>OLDER_PAGE_SIZE&&groups.length>1){
        const oldest=groups.shift()!;
        retainedCount-=oldest.paths.length;
        for(const path of oldest.paths)retained.delete(pathIdentity(path));
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

    const images=await this.validate(groups.flatMap(group=>group.paths),cwd,allowBrowserTemp);
    const orderedPaths=new Set(groups.flatMap(group=>group.paths));
    const ordered=images.filter(image=>orderedPaths.has(image.path));
    return {images:ordered,...(hasEarlier&&groups.length?{nextCursor:groups[0]!.offset}:{})};
  }

  private async validate(candidates:string[],cwd:string,allowBrowserTemp:boolean):Promise<ScreenshotRef[]>{
    let canonicalRoot:string;
    try{canonicalRoot=await realpath(cwd);}catch{return [];}
    let canonicalTemp:string|undefined;
    try{canonicalTemp=await realpath(tmpdir());}catch{/* Workspace screenshots remain available. */}
    const images:ScreenshotRef[]=[];
    const seen=new Set<string>();
    for(const candidate of candidates){
      if(!EXTENSIONS.has(extname(candidate).toLowerCase()))continue;
      try{
        const actual=await realpath(candidate);
        const inWorkspace=isWithin(canonicalRoot,actual);
        const browserScreenshot=allowBrowserTemp&&Boolean(canonicalTemp&&
          dirname(actual)===canonicalTemp&&
          BSK_SCREENSHOT_NAME.test(basename(actual))&&
          extname(actual).toLowerCase()===".png");
        if(!inWorkspace&&!browserScreenshot)continue;
        if(browserScreenshot&&((await lstat(candidate)).isSymbolicLink()||!await hasPngSignature(actual)))continue;
        const meta=await stat(actual);
        if(!meta.isFile()||meta.size<8||meta.size>MAX_BYTES)continue;
        const identity=pathIdentity(actual);
        if(seen.has(identity))continue;
        seen.add(identity);
        images.push({path:candidate,name:basename(actual),mtimeMs:meta.mtimeMs,size:meta.size});
      }catch{/* not written yet, inaccessible or unsafe */}
    }
    return images;
  }
}
