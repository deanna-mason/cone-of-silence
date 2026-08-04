// app/room/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import VideoTile from "@/components/VideoTile";
import RemoteTile from "@/components/RemoteTile";
import CallControls from "@/components/CallControls";
import DevicePicker from "@/components/DevicePicker";
import InCallDeviceBar from "@/components/InCallDeviceBar";
import PodcastPanel from "@/components/PodcastPanel";
import { LensIcon, MicIcon } from "@/components/icons";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useCallSession } from "@/hooks/useCallSession";
import { usePodcastTake } from "@/hooks/usePodcastTake";
import { mergePanel, useEpisodeExchange } from "@/hooks/useEpisodeExchange";
import { getSession } from "@/lib/authApi";
import type { CallStatus } from "@/lib/webrtc/session";
import {
  buildInviteLink,
  clearStashedRoomKeys,
  parseRoomHash,
  readForceTurn,
  readStashedRoomKeys,
  stashRoomKeys,
  type RoomKeys,
} from "@/lib/roomLink";
import { type MediaFailure } from "@/lib/webrtc/media";
import { pinStudioRoom } from "@/lib/studioRoom";

type Stage = "parsing" | "no-channel" | "green-room" | "in-room";

const FAILURE_COPY: Record<MediaFailure, { title: string; hint: string }> = {
  denied: {
    title: "Surveillance Equipment Compromised",
    hint: "The browser was refused access to your camera and microphone. Re-arm permissions in the address bar (camera icon), then retry. Already allowed there? Your operating system may be blocking the browser itself — on macOS, check System Settings → Privacy & Security → Camera and Microphone.",
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

type CallFailure = Extract<
  CallStatus,
  | "room-not-found"
  | "room-full"
  | "create-refused"
  | "signal-lost"
  | "recovery-failed"
  | "countersign-failed"
  | "equipment-outdated"
>;

const CALL_FAILURE_COPY: Record<CallFailure, { kicker: string; title: string; hint: string }> = {
  "room-not-found": {
    kicker: "◈ Channel Unknown",
    title: "This Corridor Is Dark",
    hint: "The channel was struck or never opened. Request a fresh invite from your contact.",
  },
  "room-full": {
    kicker: "◈ At Capacity",
    title: "The Cone Seats Four",
    hint: "This channel already has four agents. Ask your counterparts to open a new line.",
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
  "recovery-failed": {
    kicker: "◈ Line Not Restored",
    title: "The Channel Could Not Be Re-Established",
    hint: "The line went down mid-call and patient redialing could not bring it back. Return to the lobby and open a fresh channel — your counterparts will need a new invite.",
  },
  "countersign-failed": {
    kicker: "◈ Countersign Rejected",
    title: "The Room Refused Your Papers",
    hint: "This invitation's secret does not match the room's. Request a fresh invitation from a host.",
  },
  "equipment-outdated": {
    kicker: "◈ Obsolete Field Kit",
    title: "Your Browser Cannot Seal the Channel",
    hint: "Encrypted calls need a current browser — Chrome, Safari, or Firefox. Update and rejoin.",
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
  const [studioPinned, setStudioPinned] = useState(false);
  const [forceRelay, setForceRelay] = useState(false);
  const media = useLocalMedia(stage === "green-room" || stage === "in-room");
  const call = useCallSession(keys, media.stream, stage === "in-room", forceRelay);

  // Podcast mode is for logged-in hosts only; anonymous guests get the plain
  // call. `authed` is read in an effect so the server render never touches
  // localStorage.
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(getSession() != null);
  }, []);
  // usePodcastTake's holdRolls and useEpisodeExchange's takeActive each want
  // the OTHER hook's live output in the same render — a genuine two-hook
  // cycle. Bridged with one render's lag via a ref (same idiom as the
  // `latest`/`holdRollsRef` refs inside usePodcastTake itself): exchange.busy
  // is only ever read later, from refs, in response to user actions or wire
  // events — never during this render's own output — so a value that is at
  // most one commit stale is harmless.
  const exchangeBusyRef = useRef(false);
  const podcast = usePodcastTake({
    enabled: authed && stage === "in-room",
    bus: call.bus,
    dcOpen: call.dcOpen,
    peerIds: call.peers.map((p) => p.peerId),
    videoTrack: media.stream?.getVideoTracks()[0] ?? null,
    audioDeviceId: media.choice.audioDeviceId,
    holdRolls: exchangeBusyRef.current,
  });
  // While the tape rolls the recorded tracks are frozen: no device toggles,
  // and the self tile shows the true recorded frame.
  const podcastLocked =
    podcast.panel.kind === "countdown" ||
    podcast.panel.kind === "rolling" ||
    podcast.panel.kind === "fault" ||
    podcast.panel.kind === "stopping";
  const exchange = useEpisodeExchange({
    // "supported" isn't in usePodcastTake's public surface — panel.kind
    // stays "unsupported" forever on an unsupported browser (derivePanel's
    // very first check), so it doubles as that signal here.
    enabled: authed && stage === "in-room" && podcast.panel.kind !== "unsupported",
    xfer: call.bus.xfer,
    xferKey: call.xferKey,
    peerIds: call.peers.map((p) => p.peerId),
    myCodename: podcast.myCodename,
    partnerCodename: podcast.partnerCodename,
    lastTakeId: podcast.lastTakeId,
    takeActive: podcastLocked,
    dcOpen: call.dcOpen,
  });
  // Available for usePodcastTake on the NEXT render — see the comment above.
  exchangeBusyRef.current = exchange.busy;

  // Debug mirror for e2e/phase2-e2e.js and e2e/phase5a-e2e.js — harmless in
  // production. podBytes is this side's recorder byte counts, video and
  // audio counted SEPARATELY (hooks/usePodcastTake.ts's `bytes`) — an
  // aggregate total can't distinguish "both streams growing" from "one
  // stalled while the other grows".
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__cosCall = {
      status: call.status,
      dcOpen: call.dcOpen,
      peers: call.peers.length,
      pod: podcast.panel.kind,
      podBytes: podcast.bytes,
      xfer: exchange.debug,
    };
  }, [call.status, call.dcOpen, call.peers, podcast.panel.kind, podcast.bytes, exchange.debug]);

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
    setForceRelay(readForceTurn(window.location.search));
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

  // Pin this room as the host's standing Studio room (flow B). The E2EE secret
  // only ever moves from localStorage/fragment into localStorage — no network.
  function pinStudio() {
    if (!keys) return;
    pinStudioRoom(keys);
    setStudioPinned(true);
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

  // From here down the view is DERIVED from media state, never set optimistically:
  // failure → error card; no stream yet → equipment-check interstitial; stream →
  // green room / call. Retry just clears the failure and the view follows the
  // actual getUserMedia outcome (no flash back to the green room).
  if (media.failure) {
    const copy = FAILURE_COPY[media.failure];
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-vermilion">◈ Equipment Check Failed</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">{copy.title}</h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">{copy.hint}</p>
        <button
          type="button"
          onClick={media.retry}
          className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Retry Equipment Check
        </button>
      </section>
    );
  }

  if (stage === "green-room" && !media.stream) {
    return (
      <section className="hairline border bg-inset p-8 text-center">
        <p className="kicker text-sienna">◈ Equipment Check</p>
        <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">
          Running Equipment Check…
        </h1>
        <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">
          Awaiting camera and microphone clearance from the browser.
        </p>
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
        {authed && (
          <button
            type="button"
            onClick={pinStudio}
            className="kicker w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
          >
            {studioPinned ? "PINNED TO YOUR STUDIO" : "Pin as my Studio"}
          </button>
        )}
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

  // No-scroll rule (Deanna, 2026-07-25): every face visible at once on a
  // phone. Height = 100dvh minus the fixed chrome above this block — sticky
  // NavBar (py-4 + 1.5rem logo row ≈ 3.5rem) + main's top padding (py-12 =
  // 3rem) ≈ 6.5rem. 7rem is the measured-good value, not a derived one: the
  // e2e geometry assertion at 390×844 caught the 6.5rem estimate landing the
  // wrapper 8px below the fold, and where those 8px come from was never
  // pinned down. The footer intentionally falls below the fold in-call.
  const tileCount = 1 + Math.max(call.peers.length, 1);
  const gridClass =
    tileCount <= 2
      ? "grid-cols-1 grid-rows-[repeat(2,minmax(0,1fr))] sm:grid-cols-2 sm:grid-rows-[minmax(0,1fr)]"
      : "grid-cols-2 grid-rows-[repeat(2,minmax(0,1fr))]";

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[20rem] flex-col gap-3">
      {authed && (
        <PodcastPanel
          state={mergePanel(podcast.panel, exchange)}
          onChooseVault={() => void podcast.actions.chooseVault()}
          onGrantVault={() => void podcast.actions.grantVault()}
          onRoll={podcast.actions.roll}
          onStop={podcast.actions.stop}
          onDismissFault={podcast.actions.dismissFault}
          onSendEpisode={exchange.actions.send}
          onResendEpisode={exchange.actions.resend}
          onDismissXfer={exchange.actions.dismiss}
        />
      )}
      <header className="flex items-center justify-between">
        <p className="kicker text-sienna">◈ Secure Channel</p>
        <p className="kicker text-ink-soft" aria-live="polite">
          {call.status === "reconnecting"
            ? "Signal lost — re-establishing…"
            : `Agents present: ${1 + call.peers.length}`}
        </p>
      </header>
      <div className={`grid min-h-0 flex-1 gap-3 ${gridClass}`}>
        <VideoTile
          fill
          stream={media.stream}
          label="You"
          mirrored
          isSelf
          camOff={!media.camOn}
          episodeFrame={podcastLocked}
        />
        {call.peers.map((p, i) => (
          <RemoteTile
            key={p.peerId}
            peer={p}
            // The codename only identifies the OTHER half of a podcast pair —
            // with a fuller room it would label every tile the same.
            label={
              call.peers.length === 1
                ? (podcast.partnerCodename ?? "Agent 2")
                : `Agent ${i + 2}`
            }
          />
        ))}
        {call.peers.length === 0 && <VideoTile fill stream={null} label="Awaiting agent" />}
      </div>
      <InCallDeviceBar
        mics={media.devices.mics}
        cameras={media.devices.cameras}
        choice={media.choice}
        hasCamera={media.hasCamera}
        locked={podcastLocked}
        onSelectMic={(id) => void media.switchDevice("audio", id)}
        onSelectCamera={(id) => void media.switchDevice("video", id)}
        onFlip={() => void media.flipCamera()}
      />
      <CallControls
        micOn={media.micOn}
        camOn={media.camOn}
        copied={copied}
        onToggleMic={media.toggleMic}
        onToggleCam={media.toggleCam}
        onCopyInvite={() => void copyInvite()}
        onLeave={leave}
        disabled={podcastLocked}
      />
    </div>
  );
}
