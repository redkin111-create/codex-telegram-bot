type JsonRecord = Record<string, unknown>;

const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_CHARS = 24_000;
const MAX_RESOURCE_CHARS = 64_000;
const MAX_SCHEMA_BYTES = 8 * 1024;
const SCHEMA_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

export interface MobileMcpInputSchema {
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, MobileMcpInputSchema>;
  items?: MobileMcpInputSchema;
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean;
}

export interface MobileMcpToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
  omittedContentBlocks: number;
}

export interface MobileMcpResourceReadResult {
  text: string;
  truncated: boolean;
  omittedContentBlocks: number;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return result || undefined;
}

function sanitizeSchema(value: unknown, depth: number): MobileMcpInputSchema | undefined {
  const input = record(value);
  if (!input || depth > 6) return undefined;
  const result: MobileMcpInputSchema = {};
  if (typeof input.type === "string" && SCHEMA_TYPES.has(input.type)) result.type = input.type;
  const description = safeText(input.description, 400);
  if (description) result.description = description;
  if (Array.isArray(input.required)) {
    result.required = input.required.flatMap((entry) => {
      const name = safeText(entry, 100);
      return name && !/[\\/]/.test(name) ? [name] : [];
    }).slice(0, 40);
  }
  const rawProperties = record(input.properties);
  if (rawProperties) {
    const properties: Record<string, MobileMcpInputSchema> = {};
    for (const [rawName, rawSchema] of Object.entries(rawProperties).slice(0, 40)) {
      const name = safeText(rawName, 100);
      const property = sanitizeSchema(rawSchema, depth + 1);
      if (name && !/[\\/]/.test(name) && property) properties[name] = property;
    }
    if (Object.keys(properties).length) result.properties = properties;
  }
  const items = sanitizeSchema(input.items, depth + 1);
  if (items) result.items = items;
  if (typeof input.additionalProperties === "boolean") result.additionalProperties = input.additionalProperties;
  if (Array.isArray(input.enum)) {
    result.enum = input.enum.flatMap((entry) => {
      if (entry === null || typeof entry === "boolean") return [entry];
      if (typeof entry === "string") return [entry.slice(0, 200)];
      if (typeof entry === "number" && Number.isFinite(entry)) return [entry];
      return [];
    }).slice(0, 20);
  }
  return Object.keys(result).length ? result : undefined;
}

/** Keep only a small, harmless subset of JSON Schema; defaults, examples and extensions stay local. */
export function normalizeMobileMcpInputSchema(value: unknown): MobileMcpInputSchema | undefined {
  const schema = sanitizeSchema(value, 0);
  if (!schema) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf8") <= MAX_SCHEMA_BYTES ? schema : undefined;
  } catch { return undefined; }
}

/** Validate before crossing the ACP boundary; the MCP server receives only a bounded JSON object. */
export function validateMobileMcpArguments(value: unknown): Record<string, unknown> {
  const root = record(value);
  if (!root) throw new Error("Аргументы MCP-инструмента должны быть JSON-объектом");
  let serialized: string;
  try { serialized = JSON.stringify(root); }
  catch { throw new Error("Аргументы MCP-инструмента должны быть корректным JSON"); }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error("Аргументы MCP-инструмента не должны превышать 32 КБ");
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 4000 || current.depth > 20) throw new Error("Структура аргументов MCP-инструмента слишком сложная");
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
  }
  return root;
}

/** Support only simple named URI-template variables; operators and raw URI values never reach the browser. */
export function mobileMcpResourceTemplateParameters(template: string): string[] | undefined {
  if (typeof template !== "string" || !template.trim() || template.length > 2048 || /[\u0000-\u001f\u007f]/.test(template)) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(template)) return undefined;
  const pattern = /\{([A-Za-z_][A-Za-z0-9_.-]{0,79})\}/g;
  const parameters: string[] = [];
  const remainder = template.replace(pattern, (_match, name: string) => {
    if (!parameters.includes(name)) parameters.push(name);
    return "codex-mobile-value";
  });
  if (/[{}]/.test(remainder) || parameters.length === 0 || parameters.length > 20) return undefined;
  try {
    const parsed = new URL(remainder);
    if (parsed.username || parsed.password || parsed.hostname.includes("codex-mobile-value")) return undefined;
  } catch { return undefined; }
  return parameters;
}

/** Check that a resolved URI still has the exact fixed portions of its advertised template. */
export function mobileMcpResourceUriMatchesTemplate(template: string, uri: string): boolean {
  const parameters = mobileMcpResourceTemplateParameters(template);
  if (!parameters || typeof uri !== "string" || uri.length > 2048 || /[\u0000-\u001f\u007f{}]/.test(uri)) return false;
  const parts = template.split(/(\{[A-Za-z_][A-Za-z0-9_.-]{0,79}\})/);
  const captures = new Map<string, number>();
  let nextCapture = 0;
  const source = parts.map((part) => {
    const match = /^\{([A-Za-z_][A-Za-z0-9_.-]{0,79})\}$/.exec(part);
    if (!match) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prior = captures.get(match[1]!);
    if (prior !== undefined) return `\\${prior}`;
    const capture = ++nextCapture;
    captures.set(match[1]!, capture);
    return "((?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*)";
  }).join("");
  if (captures.size !== parameters.length) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) return false;
    return new RegExp(`^${source}$`).test(uri);
  } catch { return false; }
}

/** Resolve only a currently listed, simple template with one bounded string per named variable. */
export function resolveMobileMcpResourceTemplate(template: string, value: unknown): string {
  const parameters = mobileMcpResourceTemplateParameters(template);
  const values = record(value);
  if (!parameters || !values || Object.keys(values).length !== parameters.length ||
      parameters.some((name) => !Object.prototype.hasOwnProperty.call(values, name))) {
    throw new Error("Укажите все параметры MCP-ресурса без лишних полей");
  }
  let result = template;
  for (const name of parameters) {
    const entry = values[name];
    if (typeof entry !== "string" || entry.length > 512 || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new Error("Параметры MCP-ресурса должны быть строками до 512 символов без управляющих знаков");
    }
    const escaped = encodeURIComponent(entry).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    result = result.replaceAll(`{${name}}`, escaped);
  }
  if (result.length > 2048 || /[{}\u0000-\u001f\u007f]/.test(result)) throw new Error("Не удалось безопасно собрать URI MCP-ресурса");
  try { new URL(result); } catch { throw new Error("Не удалось безопасно собрать URI MCP-ресурса"); }
  return result;
}

function boundedJson(value: unknown): string | undefined {
  let nodes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 1000) return "[пропущено: слишком много данных]";
    if (depth > 8) return "[пропущено: слишком глубокая структура]";
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return input.slice(0, 4_000);
    if (Array.isArray(input)) return input.slice(0, 100).map((entry) => visit(entry, depth + 1));
    const obj = record(input);
    if (!obj) return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj).slice(0, 100)) {
      result[key.slice(0, 120)] = visit(child, depth + 1);
    }
    return result;
  };
  try {
    const normalized = visit(value, 0);
    return JSON.stringify(normalized);
  } catch { return undefined; }
}

/** Return only text and structured JSON; image bytes, links, resources and metadata remain server-side. */
export function normalizeMobileMcpToolResult(value: unknown): MobileMcpToolResult {
  const response = record(value);
  const pieces: string[] = [];
  let omittedContentBlocks = 0;
  const blocks = Array.isArray(response?.content) ? response.content : [];
  for (const raw of blocks.slice(0, 100)) {
    const block = record(raw);
    if (block?.type === "text" && typeof block.text === "string") pieces.push(block.text);
    else omittedContentBlocks++;
  }
  omittedContentBlocks += Math.max(0, blocks.length - 100);
  if (response && response.structuredContent !== undefined) {
    const structured = boundedJson(response.structuredContent);
    if (structured) pieces.push(structured);
  }
  const combined = pieces.join("\n\n");
  return {
    text: combined.slice(0, MAX_RESULT_CHARS),
    isError: response?.isError === true,
    truncated: combined.length > MAX_RESULT_CHARS,
    omittedContentBlocks,
  };
}

/** Keep only bounded text from MCP resources; URIs, blobs and call metadata stay local. */
export function normalizeMobileMcpResourceResult(value: unknown): MobileMcpResourceReadResult {
  const response = record(value);
  const blocks = Array.isArray(response?.contents) ? response.contents : [];
  const pieces: string[] = [];
  let omittedContentBlocks = 0;
  let remaining = MAX_RESOURCE_CHARS;
  let truncated = false;
  for (const raw of blocks.slice(0, 100)) {
    const block = record(raw);
    if (typeof block?.text !== "string") {
      omittedContentBlocks++;
      continue;
    }
    const separator = pieces.length ? "\n\n" : "";
    if (remaining <= separator.length) {
      truncated = true;
      break;
    }
    const text = block.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
    const available = remaining - separator.length;
    pieces.push(text.slice(0, available));
    remaining -= separator.length + Math.min(text.length, available);
    if (text.length > available) {
      truncated = true;
      break;
    }
  }
  omittedContentBlocks += Math.max(0, blocks.length - 100);
  return { text: pieces.join("\n\n"), truncated, omittedContentBlocks };
}
