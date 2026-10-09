/* Phone-friendly photo compression before sending attachments to local Codex. */
(function(){
  "use strict";
  var MAX_BYTES=1536*1024,MAX_SOURCE=15*1024*1024,MAX_FILES=3;
  var TYPES=["image/jpeg","image/png","image/webp"];
  function dataSize(b64){return Math.floor(b64.length*3/4)-(b64.endsWith("==")?2:b64.endsWith("=")?1:0);}
  function fileData(file){return new Promise(function(resolve,reject){
    var reader=new FileReader();reader.onerror=function(){reject(Error("Не удалось прочитать фото"));};
    reader.onload=function(){resolve(String(reader.result||""));};reader.readAsDataURL(file);
  });}
  function imageLoaded(url){return new Promise(function(resolve,reject){
    var img=new Image();img.onload=function(){resolve(img);};img.onerror=function(){reject(Error("Не удалось открыть изображение"));};
    img.src=url;
  });}
  async function prepare(file){
    if(!file||TYPES.indexOf(file.type)<0)throw Error("Поддерживаются только JPEG, PNG и WebP");
    if(file.size>MAX_SOURCE)throw Error("Фото слишком большое (максимум 15 МБ)");
    var url=await fileData(file),raw=url.split(",")[1]||"";
    if(file.size<=MAX_BYTES&&raw.length){
      return {name:file.name||"Фото",mimeType:file.type,data:raw,preview:url};
    }
    var img=await imageLoaded(url);
    var scale=Math.min(1,1600/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    if(!Number.isFinite(scale)||scale<=0)throw Error("Некорректные размеры фото");
    var canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round((img.naturalWidth||img.width)*scale));
    canvas.height=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
    var context=canvas.getContext("2d");
    if(!context)throw Error("Сжатие изображений недоступно");
    // White background avoids accidental black transparency when converting PNG.
    context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(img,0,0,canvas.width,canvas.height);
    for(var quality of [0.82,0.68,0.53,0.40]){
      var converted=canvas.toDataURL("image/jpeg",quality);
      var b64=converted.split(",")[1]||"";
      if(converted.startsWith("data:image/jpeg;")&&dataSize(b64)<=MAX_BYTES){
        return {name:file.name||"Фото",mimeType:"image/jpeg",data:b64,preview:converted};
      }
    }
    throw Error("Не удалось сжать фото до 1,5 МБ");
  }
  window.CodexPhotos={prepare:prepare,max:MAX_FILES,maxBytes:MAX_BYTES};
})();