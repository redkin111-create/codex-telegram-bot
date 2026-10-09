import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  tag:string;className="";textContent="";href="";target="";rel="";type="";
  children:Node[]=[];onclick?:()=>void;
  constructor(tag:string){this.tag=tag;}
  appendChild(node:Node){this.children.push(node);return node;}
  replaceChildren(...items:Node[]){this.children=[...items];}
}
function all(node:Node):Node[]{return [node,...node.children.flatMap(all)];}
test("Markdown renders headings, tables, code and safe links without evaluating HTML",()=>{
  const script=readFileSync("apps/mini-app/public/markdown.js","utf8");
  const win:{CodexMarkdown?:{render:(n:Node,t:string)=>void};navigator:{clipboard:{writeText:(s:string)=>Promise<void>}}}={
    navigator:{clipboard:{writeText:async()=>{}}},
  };
  let generated="";
  const document={
    createElement:(tag:string)=>new Node(tag),
    createTextNode:(text:string)=>{const n=new Node("#text");n.textContent=text;return n;},
  };
  const root=new Node("div");
  runInNewContext(script,{window:win,document,setTimeout});
  const md=[
    "# Отчёт Codex",
    "Исправлено **три файла**, [документация](https://example.com).",
    "<script>generated = 'danger'</script>",
    "[Небезопасно](javascript:alert(1))",
    "| Файл | Статус |",
    "| --- | --- |",
    "| app.ts | Готово |",
    "§§§typescript",
    "const value = 42;",
    "§§§",
  ].join("\n");
  win.CodexMarkdown!.render(root,md.replaceAll("§",String.fromCharCode(96)));
  const nodes=all(root);
  assert(nodes.some(n=>n.tag==="h1"&&n.children.some(c=>c.textContent==="Отчёт Codex")));
  assert(nodes.some(n=>n.tag==="table"));
  assert(nodes.some(n=>n.tag==="pre"));
  assert(nodes.some(n=>n.className==="md-copy"));
  assert(nodes.some(n=>n.className==="md-keyword"));
  assert(nodes.some(n=>n.tag==="a"&&n.href==="https://example.com"));
  assert(!nodes.some(n=>n.tag==="script"));
  assert(!nodes.some(n=>n.tag==="a"&&n.href.startsWith("javascript:")));
  assert.equal(generated,"");
});
