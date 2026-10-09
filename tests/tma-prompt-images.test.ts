import assert from "node:assert/strict";
import test from "node:test";
import { parseTmaImages, tmaPromptFingerprint, TMA_MAX_IMAGE_BYTES } from "../src/tma/prompt-images.js";

const image = (mimeType:string,bytes:Buffer) => ({mimeType,data:bytes.toString("base64")});
const jpeg=Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1,2,3,4,5]);
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
const webp=Buffer.from("RIFF1234WEBP1111");
test("accepts JPEG PNG and WebP files only with matching file signatures",()=>{
  assert.deepEqual(parseTmaImages([image("image/jpeg",jpeg)])[0]?.mimeType,"image/jpeg");
  assert.equal(parseTmaImages([image("image/png",png)])[0]?.mimeType,"image/png");
  assert.equal(parseTmaImages([image("image/webp",webp)])[0]?.mimeType,"image/webp");
  assert.throws(()=>parseTmaImages([image("image/jpeg",png)]),/формату/);
  assert.throws(()=>parseTmaImages([image("image/gif",jpeg)]),/JPEG/);
  assert.throws(()=>parseTmaImages([{mimeType:"image/jpeg",data:"!!!!"}]),/повреждено/);
  assert.throws(()=>parseTmaImages([image("image/jpeg",jpeg),image("image/jpeg",jpeg),
    image("image/jpeg",jpeg),image("image/jpeg",jpeg)]),/трёх/);
});
test("rejects oversized image and distinguishes prompts with same caption but different photos",()=>{
  const huge=Buffer.alloc(TMA_MAX_IMAGE_BYTES+1,0);
  huge[0]=255;huge[1]=216;huge[2]=255;
  assert.throws(()=>parseTmaImages([image("image/jpeg",huge)]),/1,5 МБ/);
  const first=parseTmaImages([image("image/jpeg",jpeg)]);
  const edited=Buffer.from(jpeg);edited[13]=12;
  const second=parseTmaImages([image("image/jpeg",edited)]);
  assert.notEqual(tmaPromptFingerprint("Check image",first),
    tmaPromptFingerprint("Check image",second));
  assert.deepEqual(parseTmaImages(undefined),[]);
});
