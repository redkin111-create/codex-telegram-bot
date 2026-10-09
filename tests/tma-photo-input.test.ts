import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("phone image input accepts small JPEG without reencoding and compresses large photos",async()=>{
  const script=readFileSync("apps/mini-app/public/photo-input.js","utf8");
  const original=Buffer.from([255,216,255,224,0,1,2,3,4,5,6,7,8,9,10,11]);
  const encoded="data:image/jpeg;base64,"+original.toString("base64");
  class FakeReader {
    result:string|null=null;
    onload:(()=>void)|null=null;
    onerror:(()=>void)|null=null;
    readAsDataURL(){this.result=encoded;this.onload?.();}
  }
  class FakeImage {
    naturalWidth=3000;naturalHeight=2000;onload:(()=>void)|null=null;
    set src(_url:string){Promise.resolve().then(()=>this.onload?.());}
  }
  let width=0,height=0;
  const ctx={fillStyle:"",fillRect(){},drawImage(){}};
  const canvas={getContext:()=>ctx,toDataURL:()=>encoded,
    set width(v:number){width=v;},get width(){return width;},
    set height(v:number){height=v;},get height(){return height;}};
  const window:{CodexPhotos?:{prepare:(file:{name:string;type:string;size:number})=>
    Promise<{name:string;mimeType:string;data:string;preview:string}>;max:number}}={};
  runInNewContext(script,{window,FileReader:FakeReader,Image:FakeImage,
    document:{createElement:()=>canvas}});
  const small=await window.CodexPhotos!.prepare({name:"photo.jpg",type:"image/jpeg",size:original.length});
  assert.equal(small.data,original.toString("base64"));
  assert.equal(small.mimeType,"image/jpeg");
  const large=await window.CodexPhotos!.prepare({name:"large.png",type:"image/png",size:2*1024*1024});
  assert.equal(large.mimeType,"image/jpeg");
  assert.equal(width,1600);
  assert.equal(height,1067);
  await assert.rejects(()=>window.CodexPhotos!.prepare({name:"photo.heic",type:"image/heic",size:1000}),/JPEG/);
  await assert.rejects(()=>window.CodexPhotos!.prepare({name:"massive.jpg",type:"image/jpeg",size:17*1024*1024}),/15 МБ/);
  assert.equal(window.CodexPhotos!.max,3);
});
