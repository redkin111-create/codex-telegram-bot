/* Codex Remote TMA — zero build-step frontend, no local secrets. */
"use strict";
(function () {
  var tg=window.Telegram&&window.Telegram.WebApp;
  if(tg){tg.ready();tg.expand();}
  var el=function(id){return document.getElementById(id);};
  var app=el("app"),state={projects:[],sessions:[],selected:null,project:"",history:[],images:[],queue:[],online:false,busy:false,tab:"sessions",loaded:null};
  var initData=tg&&tg.initData||"",inFlight=false,timer=null;
  function node(tag,klass,text){var n=document.createElement(tag);if(klass)n.className=klass;if(text!==undefined)n.textContent=String(text);return n;}
  function note(text){var n=el("toast");n.textContent=text;n.classList.remove("hidden");clearTimeout(timer);timer=setTimeout(function(){n.classList.add("hidden");},3600);}
  function warn(text){el("warning").textContent=text;el("warning").classList.toggle("hidden",!text);}
  function tab(which){state.tab=which;app.dataset.tab=which;document.querySelectorAll(".bottom-nav button").forEach(function(b){b.classList.toggle("active",b.dataset.tab===which);});if(which==="queue")void loadQueue();}
  async function api(op,args){
    if(!initData)throw Error("Откройте приложение через кнопку Mini App в Telegram-боте.");
    var resp=await fetch("/api/execute",{method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Init-Data":initData},body:JSON.stringify({op:op,args:args||{}})});
    var data=await resp.json().catch(function(){return{};});
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
    el("send").disabled=!s||!state.online||inFlight;
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
  async function renderImages(){
    var panel=el("images");panel.replaceChildren();panel.classList.add("hidden");
    if(!state.selected)return;
    var id=state.selected,paths=state.images.slice(0,6);
    for(var i=0;i<paths.length;i++){
      if(state.selected!==id)return;
      try{
        var data=await api("image",{sessionId:id,path:paths[i]});
        var img=node("img");img.src="data:"+data.mime+";base64,"+data.data;img.alt=data.name||"Скриншот Codex";
        img.onclick=function(){if(tg&&tg.openLink)tg.openLink(this.src);else window.open(this.src,"_blank");};
        panel.appendChild(img);
        panel.classList.remove("hidden");
      }catch(_){/* Missing screenshot is non-fatal. */}
    }
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
    try{var q=await api("queue",{sessionId:state.selected});state.queue=q.items||[];state.queuePaused=q.paused;renderQueue();}
    catch(err){note(err.message);}
  }
  async function pick(id){
    state.selected=id;state.loaded=null;renderSessions();renderHeader();
    tab("chat");await loadHistory();void loadQueue();
  }
  async function loadHistory(){
    if(!state.selected||inFlight)return;
    var id=state.selected;try{
      var data=await api("history",{sessionId:id});
      if(state.selected!==id)return;
      var digest=JSON.stringify((data.entries||[]).map(function(x){return[x.role,x.text&&x.text.length,x.timestamp];}));
      if(digest!==state.loaded){state.loaded=digest;state.history=data.entries||[];state.images=data.images||[];renderMessages();void renderImages();}
    }catch(err){note(err.message);}
  }
  async function refresh(){
    if(inFlight)return;inFlight=true;
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
    finally{inFlight=false;renderHeader();}
  }
  async function runAction(op,args,onSuccess){
    if(inFlight)return;inFlight=true;renderHeader();
    try{var data=await api(op,args);if(onSuccess)await onSuccess(data);return data;}
    catch(err){note(err.message);return null;}
    finally{inFlight=false;renderHeader();}
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
      await refresh();await pick(data.sessionId);note("Создан новый сеанс");
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
  on("refresh","click",function(){void loadHistory();});
  on("stop","click",function(){if(!state.selected)return;if(!window.confirm("Остановить текущую задачу Codex?"))return;void runAction("cancel",{sessionId:state.selected},function(){note("Команда остановки отправлена");});});
  on("queue-reload","click",function(){void loadQueue();});
  on("resume","click",function(){void runAction("queueResume",{sessionId:state.selected},function(){note("Очередь возобновлена");return loadQueue();});});
  document.querySelectorAll(".bottom-nav button").forEach(function(b){b.addEventListener("click",function(){tab(b.dataset.tab);});});
  tab("sessions");
  if(!initData){warn("Откройте эту страницу через Mini App своего Telegram-бота.");}
  else{void refresh();setInterval(function(){if(!document.hidden)void refresh();},6000);}
})();
