import { isAbsolute } from "node:path";

/** Return a safe destination label without exposing remote paths or credentials. */
export function gitRemoteTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const remote = value.trim();
  if (!remote || remote.startsWith("-")) return undefined;
  if (isAbsolute(remote) || /^[a-z]:[\\/]/i.test(remote) || remote.startsWith("./") || remote.startsWith("../")) {
    return "Локальный Git";
  }

  try {
    const url = new URL(remote);
    if (url.protocol === "file:") return !url.hostname || url.hostname === "localhost" ? "Локальный Git" : undefined;
    if ((url.protocol === "https:" || url.protocol === "ssh:") && url.hostname) {
      return `${url.hostname}${url.port ? `:${url.port}` : ""}`.slice(0, 180);
    }
    return undefined;
  } catch {
    const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^\s].*)$/.exec(remote);
    return scp?.[1]?.slice(0, 180);
  }
}
