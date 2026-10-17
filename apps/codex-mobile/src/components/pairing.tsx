import { useEffect, useState } from "react";
import { Check, Clipboard, KeyRound, LoaderCircle, Smartphone } from "lucide-react";
import { beginPairing, MobileApiError, pairingStatus } from "../api.js";
import type { MobileDevice } from "../types.js";
import { Button, Card, Input } from "./ui/primitives.js";

export function Pairing({ onAuthenticated }: { onAuthenticated: (device: MobileDevice, csrf: string) => void }) {
  const [name, setName] = useState("Android");
  const [pairingId, setPairingId] = useState("");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [status, setStatus] = useState<"idle" | "waiting" | "expired">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!pairingId || status !== "waiting") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped) return;
      try {
        const result = await pairingStatus();
        if (stopped) return;
        if (result.status === "approved" && result.device && result.csrfToken) {
          onAuthenticated(result.device, result.csrfToken);
          return;
        }
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof MobileApiError && cause.status === 410) {
          setStatus("expired");
          setError("Код истёк. Запросите новый.");
          return;
        }
        setError(cause instanceof Error ? cause.message : "Не удалось проверить привязку");
      }
      timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [pairingId, status, onAuthenticated]);

  async function start() {
    setError("");
    try {
      const result = await beginPairing(name.trim());
      setPairingId(result.pairingId);
      setCode(result.code);
      setExpiresAt(result.expiresAt);
      setStatus("waiting");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось начать привязку");
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { setError("Не удалось скопировать. Выделите код вручную."); }
  }

  return <main className="safe-area-top flex min-h-[100svh] items-center justify-center px-4 py-8">
    <Card className="w-full max-w-md p-6 sm:p-8">
      <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-[#44513d] bg-[#202a1c] text-accent">
        <Smartphone size={23} />
      </div>
      <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-[#a7c278]">Codex Mobile</p>
      <h1 className="text-2xl font-semibold tracking-tight text-text">Подключить устройство</h1>
      <p className="mt-3 text-sm leading-6 text-muted">Клиент входит отдельно от Telegram. Покажите код на телефоне и подтвердите его командой на ноутбуке.</p>

      {!code && <div className="mt-7 space-y-4">
        <label className="block text-sm font-medium text-text" htmlFor="device-name">Имя устройства</label>
        <Input id="device-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" />
        <Button className="w-full" onClick={() => void start()} disabled={!name.trim()}><KeyRound size={17} /> Создать код привязки</Button>
      </div>}

      {code && <div className="mt-7 space-y-4">
        <div className="rounded-2xl border border-[#536441] bg-[#1c2519] p-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-muted">Одноразовый код</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <code className="select-all font-mono text-3xl font-bold tracking-[.18em] text-accent">{code}</code>
            <Button aria-label="Скопировать код" variant="ghost" className="min-h-10 px-2" onClick={() => void copyCode()}>{copied ? <Check size={17} /> : <Clipboard size={17} />}</Button>
          </div>
          <p className="mt-3 text-xs text-muted">Действует до {new Date(expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</p>
        </div>
        <div className="rounded-xl border border-border bg-[#121713] p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">На ноутбуке, в PowerShell</p>
          <code className="mt-2 block break-all rounded-lg bg-black/25 p-3 font-mono text-sm text-text">codex-tg mobile approve {code}</code>
          <p className="mt-2 text-xs leading-5 text-muted">Команда подтверждает код локально. Адресный IP запроса не считается подтверждением.</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          {status === "waiting" ? <><LoaderCircle className="animate-spin text-accent" size={17} /> Ожидаю подтверждения на ноутбуке…</> : "Код истёк"}
        </div>
        {(status === "expired") && <Button variant="outline" className="w-full" onClick={() => { setCode(""); setPairingId(""); setStatus("idle"); setError(""); }}>Создать новый код</Button>}
      </div>}

      {error && <p className="mt-4 rounded-lg border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]" role="alert">{error}</p>}
      <p className="mt-7 border-t border-border pt-4 text-xs leading-5 text-[#788278]">Сеанс хранится в защищённой cookie. Отозвать устройство можно в настройках Codex Mobile.</p>
    </Card>
  </main>;
}
