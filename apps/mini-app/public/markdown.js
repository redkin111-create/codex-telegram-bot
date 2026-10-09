/** Safe, dependency-free Markdown renderer for Telegram WebView. */
(function(){
  "use strict";
  function el(tag,klass,text){var n=document.createElement(tag);if(klass)n.className=klass;if(text!==undefined)n.textContent=text;return n;}
  function inline(root,text){
    var re=/(\[[^\]]+\]\([^)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*)/g,position=0,m;
    while((m=re.exec(text))!==null){
      if(m.index>position)root.appendChild(document.createTextNode(text.slice(position,m.index)));
      var t=m[0];
      if(t.startsWith("`"))root.appendChild(el("code","md-inline-code",t.slice(1,-1)));
      else if(t.startsWith("**")){var b=el("strong");inline(b,t.slice(2,-2));root.appendChild(b);}
      else if(t.startsWith("~~"))root.appendChild(el("del","",t.slice(2,-2)));
      else if(t.startsWith("*"))root.appendChild(el("em","",t.slice(1,-1)));
      else{
        var title=t.slice(1,t.indexOf("](")),url=t.slice(t.indexOf("](")+2,-1);
        if(/^(https:\/\/|http:\/\/|mailto:)/i.test(url)){
          var a=el("a","md-link",title);a.href=url;a.target="_blank";a.rel="noopener noreferrer";root.appendChild(a);
        }else root.appendChild(document.createTextNode(title));
      }
      position=m.index+t.length;
    }
    if(position<text.length)root.appendChild(document.createTextNode(text.slice(position)));
  }
  function highlight(root,code){
    var keys=/^(?:const|let|var|function|return|async|await|if|else|for|while|class|interface|type|import|export|from|true|false|null|undefined|public|private|static|new|throw|try|catch|def|print|self|None|True|False|fn|mut|impl|pub|use|struct|enum|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|AND|OR|INTO|JOIN)$/;
    var re=/(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(?:\.\d+)?\b)/g,pos=0,m;
    while((m=re.exec(code))!==null){
      if(m.index>pos)root.appendChild(document.createTextNode(code.slice(pos,m.index)));
      var t=m[0],style=t.startsWith("//")||t.startsWith("#")?"md-comment":t.startsWith('"')||t.startsWith("'")?"md-string":keys.test(t)?"md-keyword":/^\d/.test(t)?"md-number":"";
      root.appendChild(style?el("span",style,t):document.createTextNode(t));pos=m.index+t.length;
    }
    if(pos<code.length)root.appendChild(document.createTextNode(code.slice(pos)));
  }
  function fenced(root,body,lang){
    var card=el("div","md-code-wrap"),bar=el("div","md-code-bar"),name=(lang||"text").slice(0,24).toLowerCase();
    bar.appendChild(el("span","",name));
    var copy=el("button","md-copy","Копировать");copy.type="button";
    copy.onclick=function(){
      var cb=window.navigator&&window.navigator.clipboard;
      if(!cb||!cb.writeText){copy.textContent="Выделите код";return;}
      cb.writeText(body).then(function(){copy.textContent="Скопировано";setTimeout(function(){copy.textContent="Копировать";},1600);})
        .catch(function(){copy.textContent="Выделите код";});
    };
    bar.appendChild(copy);card.appendChild(bar);
    var pre=el("pre","md-code"),code=el("code");
    if(/^(js|ts|jsx|tsx|javascript|typescript|python|py|rust|rs|json|sql|bash|sh|css)$/i.test(name))highlight(code,body);
    else code.textContent=body;
    pre.appendChild(code);card.appendChild(pre);root.appendChild(card);
  }
  function render(root,source){
    root.replaceChildren();
    var lines=String(source||"").replace(/\r\n?/g,"\n").split("\n");
    for(var i=0;i<lines.length;){
      var line=lines[i],trim=line.trim();
      if(!trim){i++;continue;}
      var fence=/^\s*([`~]{3,})\s*([a-zA-Z0-9+#-]*)/.exec(line);
      if(fence){
        var mark=fence[1],out=[];i++;
        while(i<lines.length&&!(lines[i].trim().startsWith(mark[0].repeat(mark.length)))){out.push(lines[i]);i++;}
        if(i<lines.length)i++;
        fenced(root,out.join("\n"),fence[2]);continue;
      }
      var heading=/^\s{0,3}(#{1,6})\s+(.+)/.exec(line);
      if(heading){var h=el("h"+heading[1].length,"md-heading");inline(h,heading[2]);root.appendChild(h);i++;continue;}
      if(/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)){root.appendChild(el("hr"));i++;continue;}
      if(/^\s*>/.test(line)){
        var quote=[];
        while(i<lines.length&&/^\s*>/.test(lines[i])){quote.push(lines[i].replace(/^\s*>\s?/,""));i++;}
        var block=el("blockquote","md-quote");inline(block,quote.join("\n"));root.appendChild(block);continue;
      }
      if(/^\s*(?:[-*+]|\d+\.)\s/.test(line)){
        var ordered=/^\s*\d+\./.test(line),list=el(ordered?"ol":"ul","md-list");
        while(i<lines.length&&/^\s*(?:[-*+]|\d+\.)\s/.test(lines[i])){
          var item=el("li");inline(item,lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/,""));list.appendChild(item);i++;
        }
        root.appendChild(list);continue;
      }
      if(line.includes("|")&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[i+1])){
        var cols=line.replace(/^\||\|$/g,"").split("|"),table=el("table","md-table"),head=el("thead"),tr=el("tr");
        cols.forEach(function(c){var th=el("th");inline(th,c.trim());tr.appendChild(th);});head.appendChild(tr);table.appendChild(head);i+=2;
        var body=el("tbody");
        while(i<lines.length&&lines[i].includes("|")&&lines[i].trim()){
          var row=el("tr");
          lines[i].replace(/^\||\|$/g,"").split("|").slice(0,cols.length).forEach(function(c){var td=el("td");inline(td,c.trim());row.appendChild(td);});
          body.appendChild(row);i++;
        }
        table.appendChild(body);var scroll=el("div","md-table-scroll");scroll.appendChild(table);root.appendChild(scroll);continue;
      }
      var paragraph=[];
      while(i<lines.length&&lines[i].trim()&&(paragraph.length===0||!(lines[i].includes("|")&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(lines[i+1])))&&(paragraph.length===0||!/^(\s*#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*>|\s*`{3}|\s*~{3})/.test(lines[i]))){
        paragraph.push(lines[i]);i++;
      }
      if(!paragraph.length){paragraph.push(lines[i]);i++;}
      var p=el("p","md-paragraph");inline(p,paragraph.join("\n"));root.appendChild(p);
    }
  }
  window.CodexMarkdown={render:render};
})();