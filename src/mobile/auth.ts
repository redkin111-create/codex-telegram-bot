import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { JsonStore } from "../app/json-store.js";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 10;

export interface MobileDeviceInfo {
  id: string;
  ownerId: number;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

interface StoredDevice extends MobileDeviceInfo {
  tokenHash: string;
  csrfHash: string;
  expiresAt: number;
}

interface DeviceData { devices: StoredDevice[]; }

interface Pairing {
  id: string;
  codeHash: string;
  cookieHash: string;
  name: string;
  createdAt: number;
  expiresAt: number;
  ownerId?: number;
}

export interface MobileAuthOptions {
  allowedOwners: ReadonlySet<string>;
  now?: () => number;
  pairingTtlMs?: number;
  sessionTtlMs?: number;
}

export interface PairingChallenge {
  id: string;
  code: string;
  pairingCookie: string;
  expiresAt: number;
}

export type PairingResult =
  | { status: "pending" }
  | { status: "approved"; cookieValue: string; csrfToken: string; device: MobileDeviceInfo };

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function randomPairingCode(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
}

function publicDevice(device: StoredDevice): MobileDeviceInfo {
  const { tokenHash: _tokenHash, csrfHash: _csrfHash, expiresAt: _expiresAt, ...info } = device;
  return { ...info };
}

export class MobileAuthStore {
  private readonly store: JsonStore<DeviceData>;
  private readonly pairings = new Map<string, Pairing>();
  private readonly codeIndex = new Map<string, string>();
  private readonly now: () => number;
  private readonly pairingTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(dataDir: string, private readonly options: MobileAuthOptions) {
    this.store = new JsonStore(join(dataDir, "mobile-devices.json"), { devices: [] });
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_LIFETIME_MS;
  }

  beginPairing(deviceName: string): PairingChallenge {
    this.prunePairings();
    if (this.pairings.size >= MAX_PENDING_PAIRINGS) throw new Error("Слишком много ожидающих привязок");
    const name = deviceName.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
    if (!name) throw new Error("Укажите имя устройства");

    let code = randomPairingCode();
    let codeHash = digest(code);
    while (this.codeIndex.has(codeHash)) {
      code = randomPairingCode();
      codeHash = digest(code);
    }
    const pairingCookie = randomBytes(32).toString("base64url");
    const pairing: Pairing = {
      id: randomUUID(), codeHash, cookieHash: digest(pairingCookie), name,
      createdAt: this.now(), expiresAt: this.now() + this.pairingTtlMs,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(codeHash, pairing.id);
    return { id: pairing.id, code, pairingCookie, expiresAt: pairing.expiresAt };
  }

  approvePairing(code: string, ownerId: number): boolean {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !this.options.allowedOwners.has(String(ownerId))) {
      throw new Error("Этот owner не разрешён в конфигурации бота");
    }
    const normalized = code.trim().toUpperCase();
    const pairingId = this.codeIndex.get(digest(normalized));
    const pairing = pairingId ? this.pairings.get(pairingId) : undefined;
    if (!pairing || pairing.expiresAt <= this.now() || pairing.ownerId) {
      if (pairing) this.removePairing(pairing.id);
      return false;
    }
    pairing.ownerId = ownerId;
    return true;
  }

  completePairing(pairingCookie: string): PairingResult | undefined {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(pairingCookie)) return undefined;
    const cookieHash = digest(pairingCookie);
    const pairing = [...this.pairings.values()].find((entry) => constantTimeHexEqual(entry.cookieHash, cookieHash));
    if (!pairing || pairing.expiresAt <= this.now()) {
      if (pairing) this.removePairing(pairing.id);
      return undefined;
    }
    if (!pairing.ownerId) return { status: "pending" };

    const now = this.now();
    const cookieValue = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomUUID(), ownerId: pairing.ownerId, name: pairing.name,
      createdAt: now, lastSeenAt: now, expiresAt: now + this.sessionTtlMs,
      tokenHash: digest(cookieValue), csrfHash: digest(csrfToken),
    };
    this.store.update((data) => { data.devices.push(device); });
    this.removePairing(pairing.id);
    return { status: "approved", cookieValue, csrfToken, device: publicDevice(device) };
  }

  authenticate(cookieValue: string | undefined): MobileDeviceInfo | undefined {
    if (!cookieValue || !/^[A-Za-z0-9_-]{40,60}$/.test(cookieValue)) return undefined;
    const tokenHash = digest(cookieValue);
    const device = this.store.get().devices.find((entry) =>
      !entry.revokedAt && entry.expiresAt > this.now() && constantTimeHexEqual(entry.tokenHash, tokenHash));
    if (!device) return undefined;
    if (this.now() - device.lastSeenAt >= 60_000) {
      const lastSeenAt = this.now();
      this.store.update((data) => {
        const stored = data.devices.find((entry) => entry.id === device.id);
        if (stored && !stored.revokedAt) stored.lastSeenAt = lastSeenAt;
      });
      device.lastSeenAt = lastSeenAt;
    }
    return publicDevice(device);
  }

  verifyCsrf(deviceId: string, csrfToken: string | undefined): boolean {
    if (!csrfToken || !/^[A-Za-z0-9_-]{40,60}$/.test(csrfToken)) return false;
    const device = this.store.get().devices.find((entry) =>
      entry.id === deviceId && !entry.revokedAt && entry.expiresAt > this.now());
    return !!device && constantTimeHexEqual(device.csrfHash, digest(csrfToken));
  }

  listDevices(ownerId: number): MobileDeviceInfo[] {
    return this.store.get().devices
      .filter((device) => device.ownerId === ownerId)
      .map(publicDevice)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revokeDevice(ownerId: number, deviceId: string): boolean {
    let revoked = false;
    const now = this.now();
    this.store.update((data) => {
      const device = data.devices.find((entry) => entry.id === deviceId && entry.ownerId === ownerId && !entry.revokedAt);
      if (device) {
        device.revokedAt = now;
        revoked = true;
      }
    });
    return revoked;
  }

  private prunePairings(): void {
    const now = this.now();
    for (const pairing of this.pairings.values()) {
      if (pairing.expiresAt <= now) this.removePairing(pairing.id);
    }
  }

  private removePairing(id: string): void {
    const pairing = this.pairings.get(id);
    if (!pairing) return;
    this.pairings.delete(id);
    this.codeIndex.delete(pairing.codeHash);
  }
}
