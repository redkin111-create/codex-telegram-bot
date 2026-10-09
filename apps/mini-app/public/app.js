/* Codex Remote TMA — zero build-step frontend, no local secrets. */
"use strict";
(function () {
  var tg=window.Telegram&&window.Telegram.WebApp;
  if(tg){tg.ready();tg.expand();}
  var el=function(id){return document.getElementById(id);};
  var app=el("app"),state={projects:[],sessions:[],selected:null,project:"",history:[],images:[],queue:[],online:false,busy:false,tab:"sessions",loaded:null};
  var initData=tg&&tg.initData||"",actionInFlight=false,snapshotInFlight=false,timer=null;
  var historyRequests=new Map(),queueRequests=new Map(),imageCache=new Map(),galleryId="",galleryKey="";
  function node(tag,klass,text){var n=document.createElement(tag);if(klass)n.className=klass;if(text!==undefined)n.textContent=String(text);return n;}
  function note(text){var n=el("toast");n.textContent=text;n.classList.remove("hidden");clearTimeout(timer);timer=setTimeout(function(){n.classList.add("hidden");},3600);}
  function warn(text){el("warning").textContent=text;el("warning").classList.toggle("hidden",!text);}
  function tab(which){state.tab=which;app.dataset.tab=which;document.querySelectorAll(".bottom-nav button").forEach(function(b){b.classList.toggle("active",b.dataset.tab===which);});if(which==="queue")void loadQueue();}
  async function api(op,args){
    if(!initData)throw Error("Откройте приложение через кнопку Mini App в Telegram-боте.");
    var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},25000);
    var resp,data;
    try{
      resp=await fetch("/api/execute",{method:"POST",cache:"no-store",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},
        body:JSON.stringify({op:op,args:args||{}})});
      data=await resp.json().catch(function(){return{};});
    }catch(error){
      if(error.name==="AbortError")throw Error("Сервер долго не отвечает. Проверь соединение и обнови чат.");
      throw error;
    }finally{clearTimeout(timeout);}
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
      var sub=node("span","sub"+(s.busy?" busy":""),(s.busy?"● Работает · ":"")+(s.cwd.split(/[\\/]/).pop()||"Проект")+" · "+fmtTime(s.updatedAt));
      info.append(title,sub);btn.append(icon,info);btn.onclick=function(){void pick(s.id);};list.append(btn);
    });
  }
  function renderHeader(){
    var s=selected();el("chat-title").textContent=s?titleOf(s):"Начните с выбора переписки";
    el("chat-project").textContent=s?(s.cwd.split(/[\\/]/).pop()||"CODEX").toUpperCase():"ВЫБЕРИТЕ СЕАНС";
    el("chat-state").textContent=s?(s.busy?"● Выполняется":state.online?"Готов к заданию · Codex Desktop может удерживать сеанс":"ПК отключён"):"Здесь появится полная история Codex";
    el("prompt").disabled=!s||!state.online;
    el("send").disabled=!s||!state.online||actionInFlight;
    el("stop").disabled=!s||!s.busy;
    el("compose-hint").textContent=!s?"Сначала выберите переписку":s.busy?"Сообщение попадёт в очередь":"Enter — отправить, Shift+Enter — новая строка";
    el("detail-title").textContent=s?titleOf(s):"Не выбран";
    el("detail-status").textContent=s?(s.busy?"Codex выполняет задачу":"Ожидание"):"Выберите переписку слева";
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
      outer.appendChild(node("div","bubble",e.text||""));
      box.appendChild(outer);
    });
    if(previousNearBottom)box.scrollTop=box.scrollHeight;
  }
  async function renderImages(force){
    var id=state.selected,paths=state.images.slice(0,6);
    var key=JSON.stringify([id,paths]);
    if(!force&&key===galleryKey&&id===galleryId)return;
    galleryId=id;galleryKey=key;
    var panel=el("images");panel.replaceChildren();panel.classList.add("hidden");
    if(!id)return;
    for(var i=0;i<paths.length;i++){
      if(state.selected!==id||galleryKey!==key)return;
      try{
        var cacheKey=id+":"+paths[i],data=imageCache.get(cacheKey);
        if(!data){data=await api("image",{sessionId:id,path:paths[i]});imageCache.set(cacheKey,data);}
        if(state.selected!==id||galleryKey!==key)return;
        var img=node("img");img.src="data:"+data.mime+";base64,"+data.data;img.alt=data.name||"Скриншот Codex";
        img.onclick=function(){
          var overlay=node("div","lightbox");
          var close=node("button","lightbox-close","✕");
          var full=node("img");full.src=this.src;full.alt=this.alt;
          function dismiss(){overlay.remove();}
          close.onclick=dismiss;overlay.onclick=function(event){if(event.target===overlay)dismiss();};
          overlay.append(close,full);document.body.append(overlay);
        };
        panel.appendChild(img);panel.classList.remove("hidden");
      }catch(_){/* A temporarily missing screenshot must not block the chat. */}
    }
    if(imageCache.size>18)imageCache.clear();
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
      galleryId="";galleryKey="";renderMessages();void renderImages();
    }
    renderSessions();renderHeader();tab("chat");
    await loadHistory();void loadQueue();
  }
  async function loadHistory(manual){
    if(!state.selected)return;
    var id=state.selected;
    if(historyRequests.has(id)){
      // Reuse the in-flight update instead of piling up duplicate requests.
      return historyRequests.get(id);
    }
    var button=el("refresh");
    if(manual){button.disabled=true;button.textContent="…";}
    var request=(async function(){
      try{
        var data=await api("history",{sessionId:id});
        if(state.selected!==id)return;
        var digest=JSON.stringify([data.entries||[],data.images||[]]);
        if(digest!==state.loaded){
          var priorImages=JSON.stringify(state.images);
          state.loaded=digest;state.history=data.entries||[];state.images=data.images||[];
          renderMessages();
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
  async function refresh(){
    if(snapshotInFlight)return;snapshotInFlight=true;
    try{
      var health=await fetch("/api/health").then(function(x){return x.json();});
      state.online=Boolean(health.online);
      var status=el("connection");status.classList.toggle("online",state.online);
      status.querySelector("span").textContent=state.online?"ПК подключён":"ПК не в сети";
      if(!state.online){renderHeader();return;}
      var data=await api("snapshot");
      state.projects=data.projects||[];state.sessions=data.sessions||[];
      if(!state.selected&&data.selected&&state.sessions.some(function(x){return x.id===data.selected;}))state.selected=data.selected;
      renderProjects();renderSessions();renderHeader();
      if(state.selected&&state.tab==="chat")void loadHistory();
      if(state.selected&&state.tab==="queue")void loadQueue();
      warn("");
    }catch(err){warn(err.message);}
    finally{snapshotInFlight=false;renderHeader();}
  }
  async function runAction(op,args,onSuccess){
    if(actionInFlight)return;actionInFlight=true;renderHeader();
    try{var data=await api(op,args);if(onSuccess)await onSuccess(data);return data;}
    catch(err){note(err.message);return null;}
    finally{actionInFlight=false;renderHeader();}
  }
  async function send(ev){
    ev.preventDefault();var text=el("prompt").value.trim();if(!text||!state.selected)return;
    var id=state.selected;
    var result=await runAction("send",{sessionId:id,text:text},async function(data){
      el("prompt").value="";
      note(data.result==="queued"?"Добавлено в очередь":data.result==="held"?"Сообщение ожидает свободный сеанс":"Задание отправлено Codex");
      await loadHistory();await loadQueue();
    });
    if(!result)el("prompt").value=text;
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
  function on(id,event,fn){el(id).addEventListener(event,fn);}
  on("project","change",function(e){state.project=e.target.value;renderSessions();});
  on("search","input",renderSessions);
  on("composer","submit",function(e){void send(e);});
  on("prompt","keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();el("composer").requestSubmit();}});
  on("new-chat","click",function(){void createSession();});
  on("refresh","click",function(){void loadHistory(true);});
  on("stop","click",function(){if(!state.selected)return;if(!window.confirm("Остановить текущую задачу Codex?"))return;void runAction("cancel",{sessionId:state.selected},function(){note("Команда остановки отправлена");});});
  on("queue-reload","click",function(){void loadQueue();});
  on("resume","click",function(){void runAction("queueResume",{sessionId:state.selected},function(){note("Очередь возобновлена");return loadQueue();});});
  document.querySelectorAll(".bottom-nav button").forEach(function(b){b.addEventListener("click",function(){tab(b.dataset.tab);});});
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
    setInterval(function(){if(!document.hidden)void refresh();},15000);
    document.addEventListener("visibilitychange",function(){
      if(!document.hidden){void refresh();if(state.selected)void loadHistory(false);}
    });
  }
})();
