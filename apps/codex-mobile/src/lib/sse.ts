export interface ParsedSseMessage { id?: number; event: string; data: string; }

export function parseSseBlock(block: string): ParsedSseMessage | undefined {
  let id: number | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) {
      const value = Number(line.slice(3).trim());
      if (Number.isSafeInteger(value) && value >= 0) id = value;
    } else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length && event === "message") return undefined;
  return { id, event, data: data.join("\n") };
}
