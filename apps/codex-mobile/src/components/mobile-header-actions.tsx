import { useEffect, useRef, useState } from "react";
import {
  FolderOpen, GitBranch, LoaderCircle, MoreHorizontal, RefreshCw, Shield, ShieldAlert, SlidersHorizontal, Terminal,
} from "lucide-react";
import { Button } from "./ui/primitives.js";

interface MobileHeaderActionsProps {
  streamConnected: boolean;
  refreshing: boolean;
  canOpenProjectTools: boolean;
  pendingApproval: boolean;
  pendingElicitation: boolean;
  onRefresh: () => void;
  onOpenApproval: () => void;
  onOpenElicitation: () => void;
  onOpenFiles: () => void;
  onOpenGit: () => void;
  onOpenTerminal: () => void;
  onOpenSettings: () => void;
  onOpenDevices: () => void;
}

export function MobileHeaderActions({
  streamConnected, refreshing, canOpenProjectTools, pendingApproval, pendingElicitation,
  onRefresh, onOpenApproval, onOpenElicitation, onOpenFiles, onOpenGit, onOpenTerminal, onOpenSettings, onOpenDevices,
}: MobileHeaderActionsProps) {
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      document.getElementById("mobile-header-actions-trigger")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return <div ref={actionsRef} className="relative flex shrink-0 items-center gap-1 sm:gap-2">
    <span className="hidden text-[11px] text-muted lg:inline">{streamConnected ? "Живые обновления" : "Поток переподключается…"}</span>
    <div className="hidden items-center gap-2 lg:flex">
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Обновить" onClick={onRefresh} disabled={refreshing}>{refreshing ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}</Button>
      {pendingApproval && <Button variant="outline" className="min-h-10 px-2 text-[#f2c66d]" aria-label="Открыть подтверждение" onClick={onOpenApproval}><ShieldAlert size={17} /></Button>}
      {pendingElicitation && <Button variant="outline" className="min-h-10 px-2 text-accent" aria-label="Открыть запрос MCP" onClick={onOpenElicitation}><ShieldAlert size={17} /></Button>}
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Файлы проекта" onClick={onOpenFiles} disabled={!canOpenProjectTools}><FolderOpen size={17} /></Button>
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Git и изменения" onClick={onOpenGit} disabled={!canOpenProjectTools}><GitBranch size={17} /></Button>
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Терминал проекта" onClick={onOpenTerminal} disabled={!canOpenProjectTools}><Terminal size={17} /></Button>
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Настройки Codex" onClick={onOpenSettings}><SlidersHorizontal size={17} /></Button>
      <Button variant="ghost" className="min-h-10 px-2" aria-label="Устройства и безопасность" onClick={onOpenDevices}><Shield size={17} /><span className="sr-only">Устройства</span></Button>
    </div>
    <div className="flex items-center gap-1 lg:hidden">
      {(pendingApproval || pendingElicitation) && <Button
        variant="outline"
        className="min-h-11 min-w-11 px-2 text-[#f2c66d]"
        aria-label="Открыть запрос, ожидающий ответа"
        onClick={() => run(pendingApproval ? onOpenApproval : onOpenElicitation)}
      ><ShieldAlert size={17} /></Button>}
      <Button
        id="mobile-header-actions-trigger"
        variant="ghost"
        className="min-h-11 min-w-11 px-2"
        aria-label="Дополнительные действия"
        aria-expanded={open}
        aria-controls="mobile-header-actions"
        onClick={() => setOpen((value) => !value)}
      ><MoreHorizontal size={19} /></Button>
    </div>
    {open && <div id="mobile-header-actions" className="absolute right-0 top-full z-50 mt-2 flex max-h-[80dvh] w-[calc(100vw-1.5rem)] max-w-80 flex-col gap-1 overflow-y-auto rounded-2xl border border-border bg-elevated p-2 shadow-soft" role="group" aria-label="Дополнительные действия">
      {pendingApproval && <Button variant="outline" className="w-full justify-start" onClick={() => run(onOpenApproval)}><ShieldAlert size={16} className="text-[#f2c66d]" />Подтверждение Codex</Button>}
      {pendingElicitation && <Button variant="outline" className="w-full justify-start" onClick={() => run(onOpenElicitation)}><ShieldAlert size={16} className="text-accent" />Запрос MCP</Button>}
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onRefresh)} disabled={refreshing}>{refreshing ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}Обновить</Button>
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onOpenFiles)} disabled={!canOpenProjectTools}><FolderOpen size={16} />Файлы проекта</Button>
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onOpenGit)} disabled={!canOpenProjectTools}><GitBranch size={16} />Git и изменения</Button>
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onOpenTerminal)} disabled={!canOpenProjectTools}><Terminal size={16} />Терминал проекта</Button>
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onOpenSettings)}><SlidersHorizontal size={16} />Настройки Codex</Button>
      <Button variant="ghost" className="w-full justify-start" onClick={() => run(onOpenDevices)}><Shield size={16} />Устройства и безопасность</Button>
    </div>}
  </div>;
}
