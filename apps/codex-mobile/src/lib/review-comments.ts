export interface MobileReviewComment {
  title: string;
  body: string;
  file: string;
  start?: number;
  end?: number;
  priority?: number;
}

export type ReviewContentSegment =
  | { type: "text"; text: string }
  | ({ type: "comment" } & MobileReviewComment);

const DIRECTIVE_PREFIX = "::code-comment{";
const MAX_DIRECTIVE_CHARS = 8_192;
const MAX_TITLE_CHARS = 240;
const MAX_BODY_CHARS = 4_000;
const MAX_FILE_CHARS = 512;
const ALLOWED_ATTRIBUTES = new Set(["title", "body", "file", "start", "end", "priority"]);

/** Split Codex's review directives from prose without interpreting them as HTML. */
export function splitCodeReviewComments(source: string): ReviewContentSegment[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const segments: ReviewContentSegment[] = [];
  let prose = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;

  const flushProse = () => {
    if (prose) segments.push({ type: "text", text: prose });
    prose = "";
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const newline = index < lines.length - 1 ? "\n" : "";
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fence) {
      prose += line + newline;
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = undefined;
      }
      continue;
    }

    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
      prose += line + newline;
      continue;
    }

    const comment = parseDirectiveLine(line);
    if (!comment) {
      prose += line + newline;
      continue;
    }

    flushProse();
    segments.push({ type: "comment", ...comment });
    prose += newline;
  }

  flushProse();
  return segments;
}

function parseDirectiveLine(line: string): MobileReviewComment | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith(DIRECTIVE_PREFIX) || !trimmed.endsWith("}") || trimmed.length > MAX_DIRECTIVE_CHARS) return undefined;

  const attributes = parseAttributes(trimmed.slice(DIRECTIVE_PREFIX.length, -1));
  if (!attributes || Object.keys(attributes).some((key) => !ALLOWED_ATTRIBUTES.has(key))) return undefined;

  const title = attributes.title?.trim();
  const body = attributes.body;
  const file = attributes.file?.trim();
  if (!title || title.length > MAX_TITLE_CHARS || !body?.trim() || body.length > MAX_BODY_CHARS || !file || file.length > MAX_FILE_CHARS) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(title + file + body.replace(/[\n\t]/g, ""))) return undefined;

  const start = positiveInteger(attributes.start);
  const end = positiveInteger(attributes.end);
  const priority = attributes.priority === undefined ? undefined : Number(attributes.priority);
  if ((attributes.start !== undefined && start === undefined) || (attributes.end !== undefined && end === undefined)) return undefined;
  if (start !== undefined && end !== undefined && end < start) return undefined;
  if (attributes.priority !== undefined && (!Number.isInteger(priority) || priority! < 0 || priority! > 3)) return undefined;

  return {
    title,
    body,
    file,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function parseAttributes(source: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  let position = 0;

  while (position < source.length) {
    while (/\s/.test(source[position] ?? "")) position++;
    if (position === source.length) break;

    const keyMatch = /^[a-zA-Z][a-zA-Z0-9_-]*/.exec(source.slice(position));
    if (!keyMatch || result[keyMatch[0]] !== undefined) return undefined;
    const key = keyMatch[0];
    position += key.length;
    if (source[position] !== "=") return undefined;
    position++;

    const quote = source[position];
    if (quote === '"') {
      position++;
      let value = "";
      let closed = false;
      while (position < source.length) {
        const char = source[position]!;
        position++;
        if (char === '"') { closed = true; break; }
        if (char === "\\") {
          if (position >= source.length) return undefined;
          const escaped = source[position]!;
          position++;
          value += escaped === "n" ? "\n"
            : escaped === "r" ? "\r"
              : escaped === "t" ? "\t"
                : escaped === "\\" || escaped === '"' ? escaped
                  : `\\${escaped}`;
        } else value += char;
      }
      if (!closed) return undefined;
      result[key] = value;
    } else {
      const valueMatch = /^[^\s]+/.exec(source.slice(position));
      if (!valueMatch) return undefined;
      result[key] = valueMatch[0];
      position += valueMatch[0].length;
    }
  }

  return result;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}
