import { useEffect, useState } from "react";
import { Laptop, Smartphone, X } from "lucide-react";
import { logout, readDevices, revokeDevice } from "../api.js";
import type { MobileDevice } from "../types.js";
import { Badge, Button, Card } from "./ui/primitives.js";

export function DevicePanel({
  current, csrf, onClose, onLogout, onSignOut,
}: { current: MobileDevice; csrf: string; onClose: () => void; onLogout: () => void; onSignOut: () => void }) {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  async function refresh() {
    try { setDevices((await readDevices()).devices); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить устройства"); }
  }
  useEffect(() => { void refresh(); }, []);

  async function revoke(device: MobileDevice) {
    setBusyId(device.id);
    setError("");
    try {
      if (device.id === current.id) {
        await logout(csrf);
        onLogout();
      } else {
        await revokeDevice(device.id, csrf);
        await refresh();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось отозвать устройство"); }
    finally { setBusyId(""); }
  }

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <Card className="max-h-[88svh] w-full overflow-y-auto rounded-b-none p-5 sm:max-w-lg sm:rounded-2xl">
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-[#a7c278]">Безопасность</p><h2 className="mt-1 text-xl font-semibold">Устройства</h2></div>
        <Button variant="ghost" aria-label="Закрыть настройки" className="min-h-10 px-2" onClick={onClose}><X size={19} /></Button>
      </div>
      <div className="mt-5 space-y-3">
        {devices.map((device) => <div key={device.id} className="flex items-center gap-3 rounded-xl border border-border bg-[#121713] p-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-elevated text-accent">{device.name.toLowerCase().includes("windows") || device.name.toLowerCase().includes("laptop") ? <Laptop size={18} /> : <Smartphone size={18} />}</span>
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-semibold">{device.name}</p>{device.id === current.id && <Badge className="border-[#536441] text-[#c9eca0]">Это устройство</Badge>}</div><p className="mt-1 text-xs text-muted">{device.revokedAt ? "Отозвано " + new Date(device.revokedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "Активно " + new Date(device.lastSeenAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</p></div>
          <Button variant={device.revokedAt ? "ghost" : "danger"} className="min-h-9 px-3 text-xs" disabled={busyId === device.id || Boolean(device.revokedAt)} onClick={() => void revoke(device)}>{device.revokedAt ? "Отозвано" : device.id === current.id ? "Выйти" : "Отозвать"}</Button>
        </div>)}
        {devices.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted">Нет привязанных устройств</p>}
      </div>
      {error && <p className="mt-4 rounded-lg border border-[#733b39] bg-[#351f1e] px-3 py-2 text-sm text-[#ffc3bd]" role="alert">{error}</p>}
      <p className="mt-5 text-xs leading-5 text-muted">Отзыв устройства немедленно прекращает доступ к проектам и сеансам.</p>
      <Button variant="outline" className="mt-4 w-full" onClick={onSignOut}>Выйти с устройства</Button>
    </Card>
  </div>;
}
