/* Codex Remote TMA — zero build-step frontend, no local secrets. */
"use strict";
(function () {
  var tg=window.Telegram&&window.Telegram.WebApp;
  if(tg){tg.ready();tg.expand();}
  var el=function(id){return document.getElementById(id);};
  var app=el("app"),state={projects:[],sessions:[],selected:null,project:"",history:[],images:[],queue:[],online:false,busy:false,tab:"sessions",loaded:null};
  var initData=tg&&tg.initData||"",actionInFlight=false,snapshotInFlight=false,timer=null;
  var historyRequests=new Map(),queueRequests=new Map(),imageCache=new Map(),galleryId="",galleryKey="";
  var pendingSend=null,liveStatus=new Map();
  var streamCtrl=null,streamSession="",streamDelay=1000,streamTimer=null,streamDisabled=false;
  var cursors=new Map(),liveDraft=new Map(),liveTools=new Map();
  var photos=[],photoBusy=false,activityRequests=new Map(),lastActivityStamp=0,lastHistoryAt=0;
  var snapshotErrors=0,lastActivityAt=0,healthFailures=0,lastHealthAt=0;
  var streamEpoch="",streamIdleTimer=null,healthInFlight=null;
  function node(tag,klass,text){var n=document.createElement(tag);if(klass)n.className=klass;if(text!==undefined)n.textContent=String(text);return n;}
  function note(text){var n=el("toast");n.textContent=text;n.classList.remove("hidden");clearTimeout(timer);timer=setTimeout(function(){n.classList.add("hidden");},3600);}
  function warn(text){el("warning").textContent=text;el("warning").classList.toggle("hidden",!text);}
  function tab(which){state.tab=which;app.dataset.tab=which;document.querySelectorAll(".bottom-nav button").forEach(function(b){b.classList.toggle("active",b.dataset.tab===which);});if(which==="queue")void loadQueue();}
  async function api(op,args){
    if(!initData)throw Error("Откройте приложение через кнопку Mini App в Telegram-боте.");
    var controller=new AbortController(),duration=op==="activity"?7000:op==="snapshot"?14000:op==="history"?18000:op==="send"?45000:25000;
    var timeout=setTimeout(function(){controller.abort();},duration);
    var resp,data;
    try{
      resp=await fetch("/api/execute",{method:"POST",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},
        body:JSON.stringify({op:op,args:args||{}})});
      data=await resp.json().catch(function(){return{};});
    }catch(error){
      if(error.name==="AbortError")throw Error(op==="snapshot"?"Список сеансов Codex обновляется медленно":
        op==="history"?"История долго загружается, повторю автоматически":
        op==="activity"?"Данные о работе Codex задерживаются":"Сервер долго не отвечает. Проверь соединение.");
      throw error;
    }finally{clearTimeout(timeout);}
    if(resp.status===401)throw Error("Telegram авторизация истекла. Закрой Mini App и открой снова через /app.");
    if(!resp.ok||!data.ok)throw Error(data.error||"Не удалось выполнить запрос");
    return data.data;
  }
  function fmtTime(sec){if(!sec)return"";var dt=new Date(sec*1000);return dt.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})+" · "+dt.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});}
  function titleOf(s){return (s.title||"Сеанс Codex").replace(/\s+/g," ").slice(0,130);}
  function selected(){return state.sessions.find(function(s){return s.id===state.selected;});}
  function renderProjects(){
    var select=el("project"),old=state.project;select.replaceChildren(new Option("Все проекты",""));
    state.projects.forEach(function(p){select.appendChild(new Option(p.name,p.path));});
    if(old && !state.projects.some(function(p){return p.path===old;}))state.project="";
    select.value=state.project;
  }
  function renderSessions(){
    var list=el("session-list");list.replaceChildren();
    var q=el("search").value.trim().toLowerCase();
    var items=state.sessions.filter(function(s){return(!state.project||s.cwd===state.project)&&(!q||(titleOf(s)+" "+s.cwd).toLowerCase().includes(q));});
    if(!items.length){list.appendChild(node("p","placeholder","Нет переписок. Выберите проект и нажмите +."));return;}
    items.forEach(function(s){
      var btn=node("button","session-item"+(state.selected===s.id?" selected":""));
      var icon=node("span","session-icon",s.source==="cli"?"⌘":"◇");
      var info=node("div","session-info"),title=node("strong","",titleOf(s));
      var ls=liveStatus.get(s.id)||s.liveStatus||"observing";
      var captions={working:"● Работает",approval:"⏳ Ждёт разрешения",completed:"✓ Завершён",
        failed:"⚠ Ошибка",cancelled:"■ Остановлен",desktop_busy:"🔒 Занят Desktop",external_activity:"● Есть активность",observing:"◉ Наблюдение"};
      var isActive=s.busy||ls==="working"||ls==="approval";
      var sub=node("span","sub"+(isActive?" busy":""),(captions[ls]||"◉ Наблюдение")+" · "+(s.cwd.split(/[\\/]/).pop()||"Проект")+" · "+fmtTime(s.updatedAt));
      info.append(title,sub);btn.append(icon,info);btn.onclick=function(){void pick(s.id);};list.append(btn);
    });
  }
  function renderHeader(){
    var s=selected();el("chat-title").textContent=s?titleOf(s):"Начните с выбора переписки";
    el("chat-project").textContent=s?(s.cwd.split(/[\\/]/).pop()||"CODEX").toUpperCase():"ВЫБЕРИТЕ СЕАНС";
    var ls=s&&(liveStatus.get(s.id)||s.liveStatus);
    var labels={working:"● Codex работает",approval:"⏳ Ждёт разрешения в Telegram",
      completed:"✓ Задание завершено",failed:"⚠ Ошибка выполнения",cancelled:"■ Остановлено",
      desktop_busy:"🔒 Сеанс занят Codex Desktop",
      observing:"◉ Наблюдение — статус Desktop неизвестен",external_activity:"● Codex записывает события в журнал"};
    el("chat-state").textContent=s?(!state.online?"Нет связи с ноутбуком":
      state.codexConnected===false?"Codex app-server переподключается":
      labels[ls]||"◉ Статус не подтверждён"):"Здесь появится полная история Codex";
    el("prompt").disabled=!s||!state.online||state.codexConnected===false;
    el("send").disabled=!s||!state.online||state.codexConnected===false||actionInFlight||photoBusy;
    el("attach-photo").disabled=!s||!state.online||photoBusy;
    el("stop").disabled=!s||!s.busy;
    el("compose-hint").textContent=!s?"Сначала выберите переписку":s.busy?"Сообщение попадёт в очередь":"Enter — отправить, Shift+Enter — новая строка";
    el("detail-title").textContent=s?titleOf(s):"Не выбран";
    el("detail-status").textContent=s?(labels[ls]||"Ожидание"):"Выберите переписку слева";
    renderActivityClock();
    el("progress-bar").style.width=s&&Number.isFinite(s.progress)?Math.max(0,Math.min(100,s.progress))+"%":"0%";
  }
  function renderMessages(){
    var box=el("messages");var previousNearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<160;
    box.replaceChildren();
    if(!state.selected){var empty=node("div","empty-state");empty.append(node("div","empty-icon","⌘"),node("strong","","Полноценный Codex на телефоне"),node("p","","Выберите сеанс и просматривайте отчёты без ограничений Telegram."));box.appendChild(empty);return;}
    if(!state.history.length){box.appendChild(node("p","placeholder","Пока нет сообщений. Можете отправить первую задачу."));return;}
    state.history.forEach(function(e){
      var outer=node("article","message "+(e.role==="user"?"user":"assistant"));
      outer.appendChild(node("span","message-head",e.role==="user"?"Вы":"Codex"));
      var bubble=node("div","bubble");
      if(window.CodexMarkdown)window.CodexMarkdown.render(bubble,e.text||"");
      else bubble.textContent=e.text||"";
      outer.appendChild(bubble);
      box.appendChild(outer);
    });
    // Screenshots live in their own strip outside the report transcript:
    // Codex may produce several of them BEFORE writing an assistant message.
    if(previousNearBottom)box.scrollTop=box.scrollHeight;
  }
  function imageRef(x){
    return typeof x==="string"?{path:x,mtimeMs:0,name:x.split(/[\\\\/]/).pop()||"Скриншот"}:x;
  }
  async function renderImages(force){
    var id=state.selected,paths=state.images.slice(-10).map(imageRef);
    var key=JSON.stringify([id,paths.map(function(x){return[x.path,x.mtimeMs,x.size];})]);
    if(!force&&key===galleryKey&&id===galleryId)return;
    galleryId=id;galleryKey=key;
    var panel=el("images"),zone=el("screenshot-zone");
    panel.replaceChildren();
    zone.classList.toggle("hidden",!id||paths.length===0);
    el("screenshot-count").textContent=paths.length+" шт.";
    if(!id||!paths.length)return;
    for(var i=0;i<paths.length;i++){
      if(state.selected!==id||galleryKey!==key)return;
      var item=paths[i];
      try{
        var cacheKey=id+":"+item.path+":"+item.mtimeMs+":"+item.size;
        var data=imageCache.get(cacheKey);
        if(!data){
          data=await api("image",{sessionId:id,path:item.path});
          imageCache.set(cacheKey,data);
        }
        if(state.selected!==id||galleryKey!==key)return;
        var card=node("div","screenshot-card");
        var img=node("img");img.src="data:"+data.mime+";base64,"+data.data;
        img.alt=data.name||item.name||"Скриншот Codex";
        img.onclick=function(){
          var overlay=node("div","lightbox"),close=node("button","lightbox-close","✕");
          var full=node("img");full.src=this.src;full.alt=this.alt;
          function dismiss(){overlay.remove();}
          close.onclick=dismiss;
          overlay.onclick=function(event){if(event.target===overlay)dismiss();};
          overlay.append(close,full);document.body.append(overlay);
        };
        card.appendChild(img);
        card.appendChild(node("span","screenshot-name",data.name||item.name||"Скриншот"));
        panel.appendChild(card);
      }catch(_){
        // The agent may have renamed or still be writing an image. Do not
        // hide other screenshots; retry when its mtime/size changes.
      }
    }
    if(imageCache.size>14)imageCache.clear();
  }
  function renderActivityClock(){
    var label=el("activity-meta"),sync=el("sync-state");
    if(!state.selected){
      label.textContent="Сначала выберите переписку";sync.textContent="Ожидание синхронизации";return;
    }
    var time=Date.now();
    if(lastHistoryAt)sync.textContent="История проверена "+Math.max(0,Math.round((time-lastHistoryAt)/1000))+" с назад";
    else sync.textContent="Ожидание истории…";
    if(!state.online){label.textContent="Нет соединения с ноутбуком";return;}
    if(lastActivityAt){
      var elapsed=Math.max(0,Math.round((time-lastActivityAt)/1000));
      label.textContent=elapsed<20?"Журнал Codex обновляется · "+elapsed+" с назад":
        "Последняя активность Codex "+elapsed+" с назад";
    }else label.textContent="Нет данных о последних действиях Codex";
  }
  function renderAttachments(){
    var container=el("attachments");container.replaceChildren();
    container.classList.toggle("hidden",photos.length===0);
    photos.forEach(function(photo,index){
      var item=node("div","attachment-chip"),img=node("img");
      img.src=photo.preview;img.alt=photo.name;
      var text=node("span","",photo.name);
      var remove=node("button","attachment-remove","×");remove.type="button";remove.title="Убрать фото";
      remove.onclick=function(){photos.splice(index,1);pendingSend=null;renderAttachments();};
      item.append(img,text,remove);container.appendChild(item);
    });
  }
  async function addPhotos(list){
    if(!window.CodexPhotos){note("Подготовка фотографий недоступна");return;}
    if(photoBusy)return;
    photoBusy=true;renderHeader();
    try{
      for(var file of Array.from(list)){
        if(photos.length>=3){note("Можно прикрепить не более трёх фото");break;}
        try{photos.push(await window.CodexPhotos.prepare(file));pendingSend=null;}
        catch(error){note(error.message);}
      }
    }finally{photoBusy=false;el("photo-picker").value="";renderAttachments();renderHeader();}
  }
  async function loadActivity(){
    var id=state.selected;
    if(!id||!state.online||activityRequests.has(id))return;
    var promise=(async function(){
      try{
        var data=await api("activity",{sessionId:id});
        if(state.selected!==id)return;
        var changed=data.mtimeMs!==lastActivityStamp;
        lastActivityStamp=data.mtimeMs;
        if(Array.isArray(data.images)){
          var next=data.images,changedImages=JSON.stringify(next)!==JSON.stringify(state.images);
          if(changedImages){state.images=next;void renderImages();}
        }
        lastActivityAt=data.mtimeMs||0;
        if(data.busy){
          liveStatus.set(id,"working");
        }else if(data.mtimeMs&&Date.now()-data.mtimeMs<18000&&
          ["observing","external_activity"].includes(liveStatus.get(id)||"observing")){
          liveStatus.set(id,"external_activity");
        }else if(liveStatus.get(id)==="external_activity"){
          liveStatus.set(id,"observing");
        }
        renderHeader();renderSessions();
        if(changed&&data.mtimeMs)void loadHistory(false);
      }catch(_){
        // A temporarily slow Codex read does not mean the tunnel is offline.
        el("activity-meta").textContent="Проверка активности задерживается — связь с ПК есть";
      }
    })();
    activityRequests.set(id,promise);
    try{await promise;}finally{activityRequests.delete(id);}
  }
  function renderQueue(){
    var box=el("queue");box.replaceChildren();
    if(!state.queue.length){box.appendChild(node("p","muted","Очередь пуста"));}else{
      state.queue.forEach(function(item,i){
        var row=node("div","queue-item");
        row.appendChild(node("strong","",(i+1)+". Ожидает"));
        row.appendChild(node("p","",(item.text||"").slice(0,200)));
        var remove=node("button","","Удалить из очереди");remove.onclick=function(){void removeQueued(item.id);};row.appendChild(remove);box.appendChild(row);
      });
    }
    el("resume").classList.toggle("hidden",!state.queuePaused||!state.queue.length);
  }
  async function loadQueue(){
    if(!state.selected)return;
    var id=state.selected;
    if(queueRequests.has(id))return queueRequests.get(id);
    var request=(async function(){
      try{
        var q=await api("queue",{sessionId:id});
        if(state.selected!==id)return;
        state.queue=q.items||[];state.queuePaused=q.paused;renderQueue();
      }catch(err){if(state.tab==="queue"&&state.selected===id)note(err.message);}
    })();
    queueRequests.set(id,request);
    try{await request;}finally{queueRequests.delete(id);}
  }
  async function pick(id){
    if(state.selected!==id){
      state.selected=id;state.loaded=null;state.history=[];state.images=[];
      lastActivityAt=0;lastActivityStamp=0;lastHistoryAt=0;
      galleryId="";galleryKey="";renderMessages();void renderImages();
    }
    renderSessions();renderHeader();tab("chat");stopStream();startStream();renderActivity();
    await loadHistory();void loadQueue();void loadActivity();
  }
  async function loadHistory(manual){
    if(!state.selected)return;
    var id=state.selected;
    if(historyRequests.has(id)){
      // Manual refresh must actually trigger a fresh read after the existing
      // background request, not merely await its potentially stale result.
      await historyRequests.get(id);
      return manual?loadHistory(false):undefined;
    }
    var button=el("refresh");
    if(manual){button.disabled=true;button.textContent="…";}
    var request=(async function(){
      try{
        var data=await api("history",{sessionId:id});
        if(state.selected!==id)return;
        lastHistoryAt=Date.now();
        renderActivityClock();
        var digest=JSON.stringify([data.entries||[],data.images||[]]);
        if(digest!==state.loaded){
          if(["completed","failed","cancelled"].includes(liveStatus.get(id)))liveDraft.delete(id);
          var priorImages=JSON.stringify(state.images);
          state.loaded=digest;state.history=data.entries||[];
          // Activity is a faster source of live image references. History
          // may have been read just before an image appeared.
          if(Array.isArray(data.images)&&data.images.length>=state.images.length)state.images=data.images;
          renderMessages();renderActivity();
          if(priorImages!==JSON.stringify(state.images))void renderImages();
        }else if(manual){note("История актуальна");}
      }catch(err){
        if(state.selected===id&&(manual||err.message.includes("авторизац")||err.message.includes("истёк")))warn(err.message);
      }finally{
        if(manual){button.disabled=false;button.textContent="⟳";}
      }
    })();
    historyRequests.set(id,request);
    try{await request;}finally{historyRequests.delete(id);}
  }
  async function healthCheck(){
    if(healthInFlight)return healthInFlight;
    healthInFlight=checkHealthOnce();
    try{return await healthInFlight;}
    finally{healthInFlight=null;}
  }
  async function checkHealthOnce(){
    var ctl=new AbortController(),timer=setTimeout(function(){ctl.abort();},6000);
    try{
      var resp=await fetch("/api/health",{cache:"no-store",signal:ctl.signal});
      if(resp.ok===false)throw Error("HTTP "+resp.status);
      var health=await resp.json();
      state.online=Boolean(health.online);
      state.codexConnected=typeof health.codexConnected==="boolean"?health.codexConnected:undefined;
      healthFailures=0;lastHealthAt=Date.now();
      var status=el("connection");status.classList.toggle("online",state.online);
      status.classList.toggle("offline",!state.online);
      status.classList.remove("reconnecting");
      status.querySelector("span").textContent=!state.online?"ПК не в сети":
        state.codexConnected===false?"Codex перезапускается":"ПК подключён";
      return state.online;
    }catch(error){
      healthFailures++;
      if(healthFailures>=2){
        state.online=false;state.codexConnected=undefined;
        var status=el("connection");status.classList.remove("online");status.classList.add("offline");
        status.querySelector("span").textContent="Проверяю соединение…";
      }
      return false;
    }finally{clearTimeout(timer);}
  }
  async function refresh(){
    if(snapshotInFlight)return;snapshotInFlight=true;
    try{
      var online=await healthCheck();
      renderHeader();
      if(!online)return;
      var data=await api("snapshot");
      snapshotErrors=0;
      state.projects=data.projects||[];state.sessions=data.sessions||[];
      state.sessions.forEach(function(s){
      if(s.liveStatus&&(!liveStatus.has(s.id)||liveStatus.get(s.id)==="observing"))liveStatus.set(s.id,s.liveStatus);
    });
      if(!state.selected&&data.selected&&state.sessions.some(function(x){return x.id===data.selected;}))state.selected=data.selected;
      renderProjects();renderSessions();renderHeader();startStream();
      if(state.selected&&state.tab==="chat")void loadHistory();
      if(state.selected&&state.tab==="queue")void loadQueue();
      warn("");
    }catch(err){
      snapshotErrors++;
      // Health can be green while Codex's catalogue RPC is slow. Avoid the
      // large warning strip on one transient timeout if chat still works.
      if(snapshotErrors>=3&&!state.sessions.length)warn(err.message);
      else if(state.online)el("activity-meta").textContent="Каталог Codex отвечает медленно; история работает отдельно";
    }
    finally{snapshotInFlight=false;renderHeader();}
  }
  async function runAction(op,args,onSuccess){
    if(actionInFlight)return;actionInFlight=true;renderHeader();
    try{var data=await api(op,args);if(onSuccess)await onSuccess(data);return data;}
    catch(err){
      if(op==="send"&&/active writer|занят.*(?:desktop|codex)|another writer/i.test(err.message)){
        liveStatus.set(args.sessionId,"desktop_busy");renderHeader();renderSessions();
      }
      note(err.message);return null;
    }
    finally{actionInFlight=false;renderHeader();}
  }
  async function send(ev){
    ev.preventDefault();var text=el("prompt").value.trim();
    if((!text&&!photos.length)||!state.selected||photoBusy)return;
    var id=state.selected;
    var fingerprint=JSON.stringify([text,photos.map(function(p){return[p.mimeType,p.data.length,p.data.slice(0,60)];})]);
    if(!pendingSend||pendingSend.sessionId!==id||pendingSend.fingerprint!==fingerprint){
      pendingSend={sessionId:id,fingerprint:fingerprint,requestId:String(Date.now())+"_"+Math.random().toString(36).slice(2,16)};
    }
    var images=photos.map(function(p){return{mimeType:p.mimeType,data:p.data};});
    var result=await runAction("send",{sessionId:id,text:text,images:images,requestId:pendingSend.requestId},async function(data){
      el("prompt").value="";photos=[];renderAttachments();pendingSend=null;
      if(data.result==="held"){
        liveStatus.set(id,"desktop_busy");renderHeader();renderSessions();
      }
      note(data.result==="queued"?"Добавлено в очередь":data.result==="held"?
        "Сеанс занят. Сообщение сохранено в боте; для продолжения открой Telegram-чат.":"Задание отправлено Codex");
      await loadHistory();await loadQueue();void loadActivity();
    });
    if(!result){
      el("prompt").value=text;
      note("Если связь прервалась, проверь историю. Повторная отправка того же задания защищена от дублей.");
    }
  }
  async function createSession(){
    var cwd=el("project").value;if(!cwd){note("Сначала выберите проект в списке");tab("sessions");return;}
    await runAction("create",{cwd:cwd},async function(data){
      state.selected=data.sessionId;
      state.sessions.unshift({id:data.sessionId,title:"Новый сеанс",cwd:cwd,updatedAt:Date.now()/1000,source:"appServer",busy:false,queue:0});
      renderSessions();renderHeader();tab("chat");await loadHistory();note("Создан новый сеанс");
    });
  }
  async function removeQueued(id){
    await runAction("queueRemove",{sessionId:state.selected,itemId:id},function(){return loadQueue();});
  }
  function renderActivity(){
    var box=el("live-activity"),id=state.selected,draft=liveDraft.get(id)||"",tools=liveTools.get(id)||[];
    box.replaceChildren();box.classList.toggle("hidden",!id||(!draft&&!tools.length));
    if(!id)return;
    if(tools.length)box.appendChild(node("div","live-heading","Активность Codex"));
    if(draft)box.appendChild(node("div","live-draft",draft));
    tools.slice(-5).forEach(function(x){box.appendChild(node("div","live-tool","⚙ "+x));});
  }
  function stopStream(){
    if(streamTimer)clearTimeout(streamTimer);
    if(streamIdleTimer)clearTimeout(streamIdleTimer);
    streamTimer=null;streamIdleTimer=null;
    if(streamCtrl)streamCtrl.abort();
    streamCtrl=null;streamSession="";
  }
  function streamEvent(e){
    if(!e||e.sessionId!==state.selected||!Number.isSafeInteger(e.id))return;
    var id=e.sessionId;
    cursors.set(id,Math.max(cursors.get(id)||0,e.id));
    if(e.kind==="status"&&e.status){
      liveStatus.set(id,e.status);renderHeader();renderSessions();
      if(["completed","failed","cancelled"].includes(e.status))void loadHistory(false);
    }else if(e.kind==="text"&&typeof e.text==="string"){
      liveDraft.set(id,((liveDraft.get(id)||"")+e.text).slice(-24000));
    }else if(e.kind==="tool"&&e.label){
      var t=liveTools.get(id)||[];t.push(e.label);liveTools.set(id,t.slice(-12));
    }
    renderActivity();
  }
  function startStream(){
    var id=state.selected;
    if(!id||!state.online||document.hidden||streamDisabled||!initData||typeof TextDecoder==="undefined"||typeof ReadableStream==="undefined")return;
    if(streamCtrl&&streamSession===id)return;
    stopStream();
    var ctl=new AbortController();streamCtrl=ctl;streamSession=id;
    (async function(){
      try{
        var rsp=await fetch("/api/stream",{method:"POST",signal:ctl.signal,cache:"no-store",
          headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},
          body:JSON.stringify({sessionId:id,after:cursors.get(id)||0,epoch:streamEpoch})});
        if(rsp.status===501){streamDisabled=true;return;}
        if(rsp.status===401){streamDisabled=true;warn("Срок авторизации истёк. Закрой Mini App и открой заново через /app.");return;}
        if(!rsp.ok||!rsp.body)throw Error("Stream HTTP "+rsp.status);
        streamDelay=1000;
        el("connection").classList.remove("reconnecting");
        var reader=rsp.body.getReader(),decoder=new TextDecoder(),buffer="",stalled=false;
        function armWatchdog(){
          if(streamIdleTimer)clearTimeout(streamIdleTimer);
          // Server sends a heartbeat every 15s. A stalled relay should recover
          // even if the TCP connection never actually closes.
          streamIdleTimer=setTimeout(function(){stalled=true;ctl.abort();},48000);
        }
        armWatchdog();
        while(!ctl.signal.aborted){
          var x=await reader.read();if(x.done)break;
          armWatchdog();
          buffer+=decoder.decode(x.value,{stream:true});
          if(buffer.length>250000)buffer=buffer.slice(-120000);
          var at;
          while((at=buffer.indexOf("\n\n"))>=0){
            var packet=buffer.slice(0,at);buffer=buffer.slice(at+2);
            if(packet.includes("event: reauth")){streamDisabled=true;warn("Перезапусти Mini App для продления авторизации.");return;}
            var line=packet.split("\n").find(function(l){return l.startsWith("data: ");});
            if(packet.includes("event: hello")){
              if(line){
                try{
                  var hello=JSON.parse(line.slice(6));
                  if(typeof hello.epoch==="string"){
                    if(streamEpoch&&streamEpoch!==hello.epoch){
                      cursors.clear();liveDraft.clear();liveTools.clear();
                      renderActivity();void loadHistory(false);
                    }
                    streamEpoch=hello.epoch;
                  }
                }catch(_){}
              }
              continue;
            }
            if(line){try{streamEvent(JSON.parse(line.slice(6)));}catch(_){}}
          }
        }
      }catch(err){
        if(!ctl.signal.aborted&&state.selected===id&&!document.hidden){
          el("connection").classList.add("reconnecting");
          el("connection").querySelector("span").textContent="Переподключение…";
        }
      }finally{
        if(streamCtrl!==ctl)return;
        if(streamIdleTimer)clearTimeout(streamIdleTimer);
        streamIdleTimer=null;
        streamCtrl=null;streamSession="";
        if((!ctl.signal.aborted||stalled)&&state.selected===id&&!document.hidden&&!streamDisabled){
          var delay=streamDelay;streamDelay=Math.min(streamDelay*2,30000);
          streamTimer=setTimeout(function(){streamTimer=null;startStream();},delay);
        }
      }
    })();
  }
  async function showDiagnostics(){
    var panel=el("diagnostics-panel");
    if(!panel.classList.contains||!panel.classList.contains("hidden")){
      panel.classList.add("hidden");return;
    }
    panel.replaceChildren();
    panel.classList.remove("hidden");
    panel.appendChild(node("strong","","Проверка Codex Remote…"));
    try{
      await healthCheck();
      var items=[];
      items.push("Ноутбук / HTTPS: "+(state.online?"доступен":"не отвечает"));
      items.push("Codex app-server: "+(state.codexConnected===true?"подключён":
        state.codexConnected===false?"не подключён":"статус неизвестен"));
      if(state.online){
        var info=await api("diagnostics");
        items.push("Работа бота: "+Math.floor(info.uptimeSeconds/60)+" мин");
        items.push("Контролируемых сеансов: "+info.botManagedSessions);
        items.push("Подтверждённых отправок: "+info.confirmed);
        items.push("Неопределённых отправок: "+(info.uncertain+info.pending));
        if(info.uncertain+info.pending>0)items.push("При неопределённой отправке сначала проверь историю и очередь.");
      }else items.push("Проверь питание и сеть ноутбука, затем Tailscale Funnel.");
      panel.replaceChildren();
      panel.appendChild(node("strong","","Диагностика TMA"));
      panel.appendChild(node("pre","diagnostics-text",items.join("\n")));
      var close=node("button","small-button","Закрыть");
      close.onclick=function(){panel.classList.add("hidden");};
      panel.appendChild(close);
    }catch(error){
      panel.replaceChildren();
      panel.appendChild(node("strong","","Диагностика недоступна"));
      panel.appendChild(node("p","",error.message||"Не удалось получить состояние Codex"));
    }
  }
  function on(id,event,fn){el(id).addEventListener(event,fn);}
  on("attach-photo","click",function(){if(!photoBusy&&state.selected)el("photo-picker").click();});
  on("photo-picker","change",function(e){void addPhotos(e.target.files||[]);});
  on("project","change",function(e){state.project=e.target.value;renderSessions();});
  on("search","input",renderSessions);
  on("composer","submit",function(e){void send(e);});
  on("prompt","keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();el("composer").requestSubmit();}});
  on("prompt","input",function(){if(pendingSend&&pendingSend.text!==el("prompt").value.trim())pendingSend=null;});
  on("new-chat","click",function(){void createSession();});
  on("diagnostics","click",function(){void showDiagnostics();});
  on("refresh","click",function(){void loadHistory(true);void loadActivity();});
  on("stop","click",function(){if(!state.selected)return;if(!window.confirm("Остановить текущую задачу Codex?"))return;void runAction("cancel",{sessionId:state.selected},function(){note("Команда остановки отправлена");});});
  on("queue-reload","click",function(){void loadQueue();});
  on("resume","click",function(){void runAction("queueResume",{sessionId:state.selected},function(){note("Очередь возобновлена");return loadQueue();});});
  document.querySelectorAll(".bottom-nav button").forEach(function(b){b.addEventListener("click",function(){tab(b.dataset.tab);});});
  if(window.addEventListener){
    window.addEventListener("offline",function(){
      state.online=false;stopStream();
      el("connection").classList.remove("online");el("connection").classList.add("offline");
      el("connection").querySelector("span").textContent="Нет соединения";
      renderHeader();
    });
    window.addEventListener("online",function(){void refresh();if(state.selected){void loadHistory(false);startStream();}});
  }
  tab("sessions");
  if(!initData){warn("Откройте эту страницу через Mini App своего Telegram-бота.");}
  else{
    void refresh();
    setInterval(function(){
      if(document.hidden)return;
      // History is independent of catalogue/status refresh; Codex messages
      // keep updating even when the project list is slow or temporarily down.
      if(state.selected&&state.tab==="chat")void loadHistory(false);
      if(state.tab==="queue")void loadQueue();
    },5000);
    setInterval(function(){if(!document.hidden)void refresh();},30000);
    setInterval(function(){
      if(!document.hidden)void healthCheck().then(function(){
        renderHeader();
        if(state.online)startStream();
      });
    },10000);
    setInterval(function(){if(!document.hidden){void loadActivity();renderActivityClock();}},4000);
    document.addEventListener("visibilitychange",function(){
      if(!document.hidden){void refresh();if(state.selected){void loadHistory(false);startStream();}}
      else stopStream();
    });
  }
})();
