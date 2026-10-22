import { useEffect, useRef } from "react";
import "../../../apps/mini-app/public/markdown.js";

export function SafeMarkdown({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (root.current) window.CodexMarkdown.render(root.current, text);
  }, [text]);
  return <div className="markdown-body" ref={root} />;
}
