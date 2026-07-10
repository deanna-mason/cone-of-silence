// app/room/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import VideoTile from "@/components/VideoTile";
import CallControls from "@/components/CallControls";
import DevicePicker from "@/components/DevicePicker";
import {
  buildInviteLink,
  clearStashedRoomKeys,
  parseRoomHash,
  readStashedRoomKeys,
  stashRoomKeys,
  type RoomKeys,
} from "@/lib/roomLink";
import {
  getLocalStream,
  listDevices,
  MediaError,
  readStashedDeviceChoice,
  stashDeviceChoice,
  stopStream,
  type DeviceLists,
  type MediaDeviceChoice,
  type MediaFailure,
} from "@/lib/webrtc/media";

type Stage = "parsing" | "no-channel" | "green-room" | "permission-error" | "in-room";

const FAILURE_COPY: Record<MediaFailure, { title: string; hint: string }> = {
  denied: {
    title: "Surveillance Equipment Compromised",
    hint: "The browser was refused access to your camera and microphone. Re-arm permissions in the address bar (camera icon), then retry.",
  },
  "no-devices": {
    title: "No Equipment Detected",
    hint: "No camera or microphone was found on this machine. Connect your gear and retry.",
  },
  unavailable: {
    title: "Equipment Malfunction",
    hint: "Your camera or microphone could not be started — another application may be holding it. Close it and retry.",
  },
};

export default function RoomPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("parsing");
  const [failure, setFailure] = useState<MediaFailure>("unavailable");
  const [keys, setKeys] = useState<RoomKeys | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<DeviceLists>({ mics: [], cameras: [] });
  const [choice, setChoice] = useState<MediaDeviceChoice>({});
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [copied, setCopied] = useState(false);

  // Arrival: read the fragment once, stash it, and strip it from the URL bar
  // so the secret never lingers in history. Refresh recovers from the stash.
  useEffect(() => {
    const fromHash = parseRoomHash(window.location.hash);
    if (fromHash) {
      stashRoomKeys(fromHash);
      window.history.replaceState(null, "", window.location.pathname);
      setKeys(fromHash);
      setStage("green-room");
      return;
    }
    const stashed = readStashedRoomKeys();
    if (stashed) {
      setKeys(stashed);
      setStage("green-room");
    } else {
      setStage("no-channel");
    }
  }, []);

  // Acquire media when entering the green room (kept across green-room ⇄ in-room).
  useEffect(() => {
    if (stage !== "green-room" || streamRef.current) return;
    let cancelled = false;
    const stored = readStashedDeviceChoice();
    setChoice(stored);
    (async () => {
      try {
        const s = await getLocalStream(stored);
        if (cancelled) {
          stopStream(s);
          return;
        }
        streamRef.current = s;
        setStream(s);
        setMicOn(true);
        setCamOn(s.getVideoTracks().length > 0);
        setDevices(await listDevices());
      } catch (err) {
        if (!cancelled) {
          setFailure(err instanceof MediaError ? err.reason : "unavailable");
          setStage("permission-error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stage]);

  // Belt-and-braces: stop tracks if the page unmounts any other way.
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  async function switchDevice(kind: "audio" | "video", deviceId: string) {
    const next: MediaDeviceChoice = {
      ...choice,
      [kind === "audio" ? "audioDeviceId" : "videoDeviceId"]: deviceId,
    };
    setChoice(next);
    stashDeviceChoice(next);
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    try {
      const s = await getLocalStream(next);
      streamRef.current = s;
      setStream(s);
      setMicOn(true);
      setCamOn(s.getVideoTracks().length > 0);
    } catch (err) {
      setFailure(err instanceof MediaError ? err.reason : "unavailable");
      setStage("permission-error");
    }
  }

  function toggleMic() {
    const s = streamRef.current;
    if (!s) return;
    const next = !micOn;
    s.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }

  function toggleCam() {
    const s = streamRef.current;
    if (!s) return;
    const next = !camOn;
    s.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  }

  async function copyInvite() {
    if (!keys) return;
    try {
      await navigator.clipboard.writeText(buildInviteLink(keys, window.location.origin));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — leave the button label unchanged
    }
  }

  function leave() {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    clearStashedRoomKeys();
    router.push("/");
  }

  if (stage === "parsing") {
    return <p className="kicker text-ink-soft">Decrypting channel…</p>;
  }

  if (stage === "no-channel") {
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-vermilion">◈ No Active Channel</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">
          Channel Not Established
        </h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">
          This corridor is dark. Request a fresh invite from your contact, or open a new line
          from the lobby.
        </p>
        <Link
          href="/"
          className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Return to Lobby
        </Link>
      </section>
    );
  }

  if (stage === "permission-error") {
    const copy = FAILURE_COPY[failure];
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-vermilion">◈ Equipment Check Failed</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">{copy.title}</h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">{copy.hint}</p>
        <button
          type="button"
          onClick={() => setStage("green-room")}
          className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Retry Equipment Check
        </button>
      </section>
    );
  }

  if (stage === "green-room") {
    return (
      <div className="space-y-6">
        <header>
          <p className="kicker text-sienna">◈ Green Room — Final Check</p>
          <h1 className="mt-2 font-display text-5xl tracking-[0.04em] text-ink">
            Check Your Cover
          </h1>
        </header>
        <VideoTile stream={stream} label="You" mirrored isSelf camOff={!camOn} />
        <div className="grid gap-4 sm:grid-cols-2">
          <DevicePicker
            label="Microphone"
            devices={devices.mics}
            selectedId={choice.audioDeviceId ?? devices.mics[0]?.deviceId}
            onSelect={(id) => void switchDevice("audio", id)}
          />
          <DevicePicker
            label="Camera"
            devices={devices.cameras}
            selectedId={choice.videoDeviceId ?? devices.cameras[0]?.deviceId}
            onSelect={(id) => void switchDevice("video", id)}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            aria-pressed={micOn}
            onClick={toggleMic}
            className={`kicker border px-4 py-3 transition ${
              micOn ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
            }`}
          >
            {micOn ? "Mic Live" : "Mic Cut"}
          </button>
          <button
            type="button"
            aria-pressed={camOn}
            onClick={toggleCam}
            className={`kicker border px-4 py-3 transition ${
              camOn ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
            }`}
          >
            {camOn ? "Lens Open" : "Lens Capped"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setStage("in-room")}
          disabled={!stream}
          className="cta-glow flex w-full items-center justify-between gap-3 bg-vermilion px-6 py-5 font-display text-3xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span>Enter the Cone</span>
          <span aria-hidden className="font-body text-2xl">
            ➔
          </span>
        </button>
      </div>
    );
  }

  // in-room
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <p className="kicker text-sienna">◈ Secure Channel</p>
        <p className="kicker text-ink-soft">Agents present: 1</p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VideoTile stream={stream} label="You" mirrored isSelf camOff={!camOn} />
        <VideoTile stream={null} label="Awaiting agent" />
      </div>
      <CallControls
        micOn={micOn}
        camOn={camOn}
        copied={copied}
        onToggleMic={toggleMic}
        onToggleCam={toggleCam}
        onCopyInvite={() => void copyInvite()}
        onLeave={leave}
      />
    </div>
  );
}
