import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { MobileAuthStore } from "./auth.js";

const TOKEN_FILE = "mobile-admin-token";
const MAX_CONTROL_MESSAGE_BYTES = 4096;

interface ApprovalRequest {
  token: string;
  code: string;
  ownerId: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function tokenPath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE);
}

async function readToken(path: string): Promise<string> {
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new Error("Файл локального ключа Codex Mobile повреждён");
  return token;
}

export async function getOrCreateMobileAdminToken(dataDir: string): Promise<string> {
  const path = tokenPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try { return await readToken(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readToken(path);
  }
}

/** A local-only IPC address; this is never part of the mobile HTTP listener. */
export function mobileControlAddress(dataDir: string, platform = process.platform): string {
  const identity = createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 32);
  if (platform === "win32") return `\\\\.\\pipe\\codex-mobile-${identity}`;
  return join(tmpdir(), `codex-mobile-${identity}.sock`);
}

function reply(socket: Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(JSON.stringify({ status, message }) + "\n");
}

function onControlConnection(socket: Socket, auth: MobileAuthStore, expectedToken: string): void {
  socket.setTimeout(5000, () => reply(socket, 408, "Запрос локального подтверждения истёк"));
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (Buffer.byteLength(input, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
      reply(socket, 413, "Слишком большой запрос локального подтверждения");
      return;
    }
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    let request: ApprovalRequest;
    try { request = JSON.parse(input.slice(0, newline)) as ApprovalRequest; }
    catch { reply(socket, 400, "Неверный формат запроса"); return; }
    if (!request || typeof request !== "object" || typeof request.token !== "string" || !sameSecret(request.token, expectedToken)) {
      reply(socket, 401, "Локальный ключ Codex Mobile не принят");
      return;
    }
    if (typeof request.code !== "string" || !Number.isSafeInteger(request.ownerId)) {
      reply(socket, 400, "Укажите действительный код и числовой owner ID");
      return;
    }
    try {
      const approved = auth.approvePairing(request.code, request.ownerId);
      reply(socket, approved ? 200 : 404, approved ? "Устройство подтверждено" : "Код истёк или уже использован");
    } catch (error) {
      reply(socket, 403, error instanceof Error ? error.message : "Owner не разрешён");
    }
  });
}

export interface MobileControlChannel {
  address: string;
  close(): Promise<void>;
}

export async function startMobileControlChannel(options: {
  auth: MobileAuthStore;
  dataDir: string;
  adminToken: string;
}): Promise<MobileControlChannel> {
  const address = mobileControlAddress(options.dataDir);
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onControlConnection(socket, options.auth, options.adminToken);
  });
  server.maxConnections = 16;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  if (process.platform !== "win32") await chmod(address, 0o600);
  return {
    address,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function requestApproval(address: string, request: ApprovalRequest): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(address);
    let response = "";
    let sent = false;
    socket.setTimeout(5000, () => socket.destroy(new Error("Не удалось связаться с локальным сервисом Codex Mobile")));
    socket.once("connect", () => {
      sent = true;
      socket.end(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
        socket.destroy(new Error("Некорректный ответ локального сервиса"));
      }
    });
    socket.once("end", () => {
      try {
        const result = JSON.parse(response) as { status?: number; message?: string };
        if (result.status === 200) resolvePromise();
        else reject(new Error(typeof result.message === "string" ? result.message : "Не удалось подтвердить устройство"));
      } catch { reject(new Error("Не удалось прочитать ответ локального сервиса Codex Mobile")); }
    });
    socket.once("error", (error) => {
      reject(sent ? error : new Error("Codex Mobile не запущен или локальный канал подтверждения недоступен"));
    });
  });
}

export async function approveMobilePairing(input: {
  code: string;
  ownerId: number;
  dataDir: string;
}): Promise<void> {
  if (!/^[A-Z2-9]{10}$/i.test(input.code.trim()) || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1) {
    throw new Error("Укажите действительный код и числовой owner ID");
  }
  const token = await readToken(tokenPath(input.dataDir));
  await requestApproval(mobileControlAddress(input.dataDir), {
    token,
    code: input.code.trim().toUpperCase(),
    ownerId: input.ownerId,
  });
}
