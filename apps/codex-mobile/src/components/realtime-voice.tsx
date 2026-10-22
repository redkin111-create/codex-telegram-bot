import { useEffect, useRef, useState } from "react";
import { AudioLines, LoaderCircle, Mic, PhoneOff } from "lucide-react";
import type { MobileLiveEvent, MobileRealtimeVoices } from "../types.js";
import { Button } from "./ui/primitives.js";

type VoicePhase = "idle" | "requesting" | "connecting" | "live" | "stopping";

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 10_000): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Браузер не собрал данные для голосового соединения"));
    }, timeoutMs);
    const changed = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

function waitForChannel(channel: RTCDataChannel, timeoutMs = 25_000): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Codex не открыл голосовой канал"));
    }, timeoutMs);
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Голосовое соединение Codex закрыто")); };
    const cleanup = () => {
      window.clearTimeout(timer);
      channel.removeEventListener("open", opened);
      channel.removeEventListener("error", failed);
      channel.removeEventListener("close", failed);
    };
    channel.addEventListener("open", opened, { once: true });
    channel.addEventListener("error", failed, { once: true });
    channel.addEventListener("close", failed, { once: true });
  });
}

function closeLocalVoice(peer: RTCPeerConnection | undefined, stream: MediaStream | undefined, channel: RTCDataChannel | undefined, audio: HTMLAudioElement | null) {
  channel?.close();
  peer?.close();
  stream?.getTracks().forEach((track) => track.stop());
  if (audio) audio.srcObject = null;
}

export function RealtimeVoiceControl({
  connected, blocked, ephemeral, events, onLoadVoices, onStart, onStop,
}: {
  connected: boolean;
  blocked: boolean;
  ephemeral: boolean;
  events: MobileLiveEvent[];
  onLoadVoices: () => Promise<MobileRealtimeVoices>;
  onStart: (offerSdp: string, voice?: string) => Promise<string>;
  onStop: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [voices, setVoices] = useState<string[]>([]);
  const [defaultVoice, setDefaultVoice] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("");
  const peerRef = useRef<RTCPeerConnection | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const channelRef = useRef<RTCDataChannel | undefined>(undefined);
  const serverStartedRef = useRef(false);
  const generationRef = useRef(0);
  const voiceStartEventFloorRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let current = true;
    setVoices([]);
    setDefaultVoice("");
    setSelectedVoice("");
    if (connected && !ephemeral) void onLoadVoices().then((result) => {
      if (!current || !result || !Array.isArray(result.voices)) return;
      const safe = [...new Set(result.voices.filter((voice) => typeof voice === "string" && /^[a-z][a-z0-9_]{0,31}$/i.test(voice)))].slice(0, 64);
      const preferred = safe.includes(result.defaultVoice) ? result.defaultVoice : "";
      setVoices(safe);
      setDefaultVoice(preferred);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [connected, ephemeral, onLoadVoices]);

  useEffect(() => {
    if (phase !== "live") return;
    const ended = events.find((event) => event.id > voiceStartEventFloorRef.current && event.kind === "activity" &&
      (event.label === "Голосовой режим Codex завершён" || event.label === "Ошибка голосового соединения Codex"));
    if (!ended) return;
    // Codex has already closed its transport. Release the phone's microphone now
    // and avoid sending a redundant stop request from the unmount cleanup.
    serverStartedRef.current = false;
    closeLocal();
    setPhase("idle");
    if (ended.label === "Ошибка голосового соединения Codex") {
      setStatus("");
      setError("Codex завершил голосовое соединение с ошибкой.");
    } else {
      setError("");
      setStatus("Codex завершил голосовой режим");
    }
  }, [events, phase]);

  function closeLocal() {
    closeLocalVoice(peerRef.current, streamRef.current, channelRef.current, audioRef.current);
    peerRef.current = undefined;
    streamRef.current = undefined;
    channelRef.current = undefined;
  }

  useEffect(() => () => {
    generationRef.current++;
    const shouldStop = serverStartedRef.current;
    serverStartedRef.current = false;
    closeLocalVoice(peerRef.current, streamRef.current, channelRef.current, audioRef.current);
    peerRef.current = undefined;
    streamRef.current = undefined;
    channelRef.current = undefined;
    if (shouldStop) void onStop().catch(() => undefined);
  }, [onStop]);

  async function start() {
    if (phase !== "idle" || !connected || blocked || ephemeral) return;
    voiceStartEventFloorRef.current = events.reduce((latest, event) => Math.max(latest, event.id), 0);
    const generation = ++generationRef.current;
    setError("");
    setStatus("Запрашиваю доступ к микрофону…");
    setPhase("requesting");
    let serverStarted = false;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof window.RTCPeerConnection !== "function") {
        throw new Error("Голосовой режим требует HTTPS и браузер с поддержкой WebRTC");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== generationRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events", { ordered: true });
      channelRef.current = channel;
      peer.addEventListener("track", (event) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audioRef.current.play().catch(() => setStatus("Соединение установлено. Разрешите воспроизведение звука в браузере."));
      });
      peer.addEventListener("connectionstatechange", () => {
        if (generation === generationRef.current && peer.connectionState === "connected") setStatus("Голосовой режим активен");
        if (generation === generationRef.current && peer.connectionState === "failed") setError("Не удалось установить голосовое соединение. Попробуйте ещё раз.");
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (generation !== generationRef.current) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Браузер не создал SDP-предложение для голосового режима");
      setStatus("Подключаю голосовой канал Codex…");
      setPhase("connecting");
      const answer = await onStart(sdp, selectedVoice || undefined);
      serverStarted = true;
      serverStartedRef.current = true;
      if (generation !== generationRef.current) { await onStop().catch(() => undefined); return; }
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      await waitForChannel(channel);
      if (generation !== generationRef.current) { await onStop().catch(() => undefined); return; }
      setPhase("live");
      setStatus("Голосовой режим активен");
    } catch (cause) {
      if (serverStarted) {
        serverStartedRef.current = false;
        await onStop().catch(() => undefined);
      }
      closeLocal();
      if (generation === generationRef.current) {
        setPhase("idle");
        setStatus("");
        setError(cause instanceof Error ? cause.message : "Не удалось подключить голосовой режим");
      }
    }
  }

  async function stop() {
    if (phase === "idle" || phase === "stopping") return;
    ++generationRef.current;
    setPhase("stopping");
    setError("");
    try {
      if (serverStartedRef.current) await onStop();
    } catch {
      setError("Связь с Codex потеряна. Закрываю голосовой канал на телефоне.");
    } finally {
      serverStartedRef.current = false;
      closeLocal();
      setPhase("idle");
      setStatus("");
    }
  }

  if (!connected) return null;
  const disabled = phase === "requesting" || phase === "connecting" || phase === "stopping" || blocked || ephemeral;
  return <div className="mx-auto mb-2 flex max-w-4xl flex-wrap items-center gap-2 rounded-xl border border-border bg-panel/70 px-3 py-2">
    <audio ref={audioRef} autoPlay playsInline className="sr-only" aria-label="Голос Codex" />
    {voices.length > 0 && <label className="flex min-h-10 items-center gap-2 rounded-lg border border-border px-2 text-xs text-muted">
      <span>Голос</span>
      <select aria-label="Голос Codex" value={selectedVoice} onChange={(event) => setSelectedVoice(event.target.value)} disabled={disabled} className="max-w-36 bg-transparent text-foreground outline-none">
        <option value="">По умолчанию{defaultVoice ? ` (${defaultVoice})` : ""}</option>
        {voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
      </select>
    </label>}
    {phase === "idle"
      ? <Button type="button" variant="outline" className="min-h-10 gap-2 px-3 text-xs" onClick={() => void start()} disabled={disabled} aria-label="Начать голосовой режим Codex">
        {blocked || ephemeral ? <AudioLines size={15} /> : <Mic size={15} />}
        Начать голосовой режим
      </Button>
      : <Button type="button" variant="outline" className="min-h-10 gap-2 border-[#774642] px-3 text-xs text-[#ffc3bd]" onClick={() => void stop()} aria-label={phase === "live" ? "Остановить голосовой режим Codex" : "Отменить подключение голоса Codex"} disabled={phase === "stopping"}>
        {phase === "stopping" || phase === "requesting" || phase === "connecting" ? <LoaderCircle size={15} className="animate-spin" /> : <PhoneOff size={15} />}
        {phase === "live" ? "Завершить голосовой режим" : phase === "stopping" ? "Отключаю голос…" : "Отменить подключение"}
      </Button>}
    <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted" role={error ? "alert" : "status"}>
      {error || (blocked ? "Сначала дождитесь завершения текущей задачи и очереди." : ephemeral ? "Голос недоступен во временном side chat." : status || "Микрофон включится только после нажатия. Аудио передаётся в Codex по WebRTC.")}
    </span>
  </div>;
}
