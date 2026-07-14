// app/room/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import VideoTile from "@/components/VideoTile";
import CallControls from "@/components/CallControls";
import DevicePicker from "@/components/DevicePicker";
import { LensIcon, MicIcon } from "@/components/icons";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useCallSession } from "@/hooks/useCallSession";
import type { CallStatus } from "@/lib/webrtc/session";
import {
  buildInviteLink,
  clearStashedRoomKeys,
  parseRoomHash,
  readStashedRoomKeys,
  stashRoomKeys,
  type RoomKeys,
} from "@/lib/roomLink";
import { type MediaFailure } from "@/lib/webrtc/media";

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

type CallFailure = Extract<CallStatus, "room-not-found" | "room-full" | "create-refused" | "signal-lost">;

const CALL_FAILURE_COPY: Record<CallFailure, { kicker: string; title: string; hint: string }> = {
  "room-not-found": {
    kicker: "◈ Channel Unknown",
    title: "This Corridor Is Dark",
    hint: "The channel was struck or never opened. Request a fresh invite from your contact.",
  },
  "room-full": {
    kicker: "◈ At Capacity",
    title: "The Cone Seats Two",
    hint: "This channel already has both agents. Ask your counterpart to open a new line.",
  },
  "create-refused": {
    kicker: "◈ Clearance Refused",
    title: "Clearance Not Recognized",
    hint: "The switchboard refused your creation clearance. Contact the quartermaster for a fresh grant.",
  },
  "signal-lost": {
    kicker: "◈ Signal Lost",
    title: "The Line Went Dead",
    hint: "The switchboard could not be reached. Return to the lobby and open the channel again.",
  },
};

function isCallFailure(status: CallStatus): status is CallFailure {
  return status in CALL_FAILURE_COPY;
}

export default function RoomPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("parsing");
  const [keys, setKeys] = useState<RoomKeys | null>(null);
  const [copied, setCopied] = useState(false);
  const media = useLocalMedia(stage === "green-room" || stage === "in-room");
  const call = useCallSession(keys?.roomId ?? null, media.stream, stage === "in-room");

  // Debug mirror for the phase2 e2e script — harmless in production.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__cosCall = {
      status: call.status,
      dcOpen: call.dcOpen,
    };
  }, [call.status, call.dcOpen]);

  // A terminal call failure ends the operation — release the camera/mic so
  // the tally light matches what the user believes. (media.stop reads refs,
  // so the churning `media` identity is safe to omit from deps.)
  useEffect(() => {
    if (isCallFailure(call.status)) media.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.status]);

  // Arrival: read the fragment once, stash it, and strip it from the URL bar
  // via replaceState so the secret never lingers in history. Refresh recovers from the stash.
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

  // Media failure is the hook's state; the stage machine mirrors it.
  useEffect(() => {
    if (media.failure) setStage("permission-error");
  }, [media.failure]);

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
    media.stop();
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
    const copy = FAILURE_COPY[media.failure ?? "unavailable"];
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-vermilion">◈ Equipment Check Failed</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">{copy.title}</h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">{copy.hint}</p>
        <button
          type="button"
          onClick={() => {
            media.retry();
            setStage("green-room");
          }}
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
        <VideoTile stream={media.stream} label="You" mirrored isSelf camOff={!media.camOn} />
        <div className="grid gap-4 sm:grid-cols-2">
          <DevicePicker
            label="Microphone"
            devices={media.devices.mics}
            selectedId={media.choice.audioDeviceId ?? media.devices.mics[0]?.deviceId}
            onSelect={(id) => void media.switchDevice("audio", id)}
          />
          <DevicePicker
            label="Camera"
            devices={media.devices.cameras}
            selectedId={media.choice.videoDeviceId ?? media.devices.cameras[0]?.deviceId}
            onSelect={(id) => void media.switchDevice("video", id)}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            aria-pressed={media.micOn}
            onClick={media.toggleMic}
            className={`kicker inline-flex items-center gap-2 border px-4 py-3 transition ${
              media.micOn ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
            }`}
          >
            <MicIcon on={media.micOn} />
            {media.micOn ? "Mic Live" : "Mic Cut"}
          </button>
          <button
            type="button"
            aria-pressed={media.camOn}
            disabled={!media.hasCamera}
            onClick={media.toggleCam}
            className={`kicker inline-flex items-center gap-2 border px-4 py-3 transition disabled:cursor-not-allowed disabled:opacity-50 ${
              media.camOn ? "border-brass text-ink" : "border-vermilion/60 text-vermilion"
            }`}
          >
            <LensIcon on={media.camOn} />
            {media.camOn ? "Lens Open" : "Lens Capped"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setStage("in-room")}
          disabled={!media.stream}
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
  if (isCallFailure(call.status)) {
    const copy = CALL_FAILURE_COPY[call.status];
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-vermilion">{copy.kicker}</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">{copy.title}</h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">{copy.hint}</p>
        <button
          type="button"
          onClick={leave}
          className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Return to Lobby
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <p className="kicker text-sienna">◈ Secure Channel</p>
        <p className="kicker text-ink-soft" aria-live="polite">
          {call.status === "reconnecting"
            ? "Signal lost — re-establishing…"
            : `Agents present: ${call.remoteStream ? 2 : 1}`}
        </p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <VideoTile stream={media.stream} label="You" mirrored isSelf camOff={!media.camOn} />
        <VideoTile
          stream={call.remoteStream}
          label={call.remoteStream ? "Counterpart" : "Awaiting agent"}
        />
      </div>
      <CallControls
        micOn={media.micOn}
        camOn={media.camOn}
        copied={copied}
        onToggleMic={media.toggleMic}
        onToggleCam={media.toggleCam}
        onCopyInvite={() => void copyInvite()}
        onLeave={leave}
      />
    </div>
  );
}
