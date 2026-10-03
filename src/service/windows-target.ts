import { win32 } from "node:path";

export interface TaskAction {
  command: string;
  arguments: string;
}

export function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function actionFromTaskXml(xml: string): TaskAction | undefined {
  const command = xmlElement(xml, "Command");
  const args = xmlElement(xml, "Arguments") ?? "";
  return command ? { command: decodeXml(command).trim(), arguments: decodeXml(args).trim() } : undefined;
}

export function sourceFromTaskAction(action: TaskAction, launcherText?: string): string | undefined {
  const vbs = /"([^"\r\n]+\.vbs)"|([^\s"]+\.vbs)/i.exec(action.arguments);
  if (vbs) {
    const launcher = vbs[1] ?? vbs[2]!;
    const cwd = launcherText && /sh\.CurrentDirectory\s*=\s*"([^"]+)"/i.exec(launcherText)?.[1];
    return cwd ? win32.resolve(cwd) : win32.dirname(win32.resolve(launcher));
  }
  const combined = `${action.command} ${action.arguments}`;
  const entry = /([a-z]:\\[^"\r\n]*?src\\index\.ts)/i.exec(combined)?.[1];
  return entry ? win32.dirname(win32.dirname(entry)) : undefined;
}

export function sameWindowsCheckout(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  return normalizeWindowsPath(expected) === normalizeWindowsPath(actual);
}

export function normalizeWindowsPath(path: string): string {
  return win32.resolve(path.trim()).replace(/[\\/]+$/, "").toLocaleLowerCase();
}

export function staleTargetMessage(expected: string, actual: string | undefined): string {
  return [
    "❌ Existing CodexTelegramBot service points to another checkout.",
    "",
    `Expected:\n${win32.resolve(expected)}`,
    "",
    `Actual:\n${actual ? win32.resolve(actual) : "could not determine the task target"}`,
    "",
    "Reinstall the service from the current checkout.",
  ].join("\n");
}

function xmlElement(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1];
}
