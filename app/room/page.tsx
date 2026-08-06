// app/room/page.tsx
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import VideoTile from "@/components/VideoTile";
import RemoteTile from "@/components/RemoteTile";
import CallControls from "@/components/CallControls";
import DevicePicker from "@/components/DevicePicker";
import InCallDeviceBar from "@/components/InCallDeviceBar";

// The podcast deck (recorder, Tape Vault, exchange, tone marks) is a heavy
// slice only two logged-in hosts ever use — code-split it so guests and plain
// callers never download it. next/dynamic = React.lazy + Suspense; the `loading`
// fallback genuinely renders while the chunk arrives (sized to the panel's row
// to avoid layout shift).
const PodcastPanel = dynamic(() => import("@/components/PodcastPanel"), {
  loading: () => (
    <div className="hairline flex h-12 items-center gap-3 border bg-inset px-4">
      <p className="kicker shrink-0 text-ink-soft">◈ Studio Deck</p>
      <p className="font-body text-sm text-ink-soft">Warming up the equipment…</p>
    </div>
  ),
});
import { LensIcon, MicIcon } from "@/components/icons";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useCallSession } from "@/hooks/useCallSession";
import { usePodcastTake } from "@/hooks/usePodcastTake";
import { useSpeaking } from "@/hooks/useSpeaking";
import { SELF_SPEAKER, useSpeakerLatch } from "@/hooks/useSpeakerLatch";
import { mergePanel, useEpisodeExchange } from "@/hooks/useEpisodeExchange";
import { getSessionSnapshot } from "@/lib/authApi";
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
import {
  pinStudioRoom,
  readStudioName,
  readStudioRoomSnapshot,
  subscribeStudioRoom,
} from "@/lib/studioRoom";

type Stage = "parsing" | "no-channel" | "green-room" | "in-room";

// A distinct second-line pointer for the failures an OS-level block can cause
// (a tester allowed the browser and still hit repeat failures without finding
// the old inline hint, 8/3). Some OS blocks surface as NotReadableError
// ("unavailable"), not a denial — so it rides both cards.
const OS_POINTER = {
  heading: "Still Locked Out After Allowing?",
  intro: "Your operating system may be blocking the browser itself.",
  macOS: "macOS: System Settings → Privacy & Security → Camera and Microphone.",
  windows: "Windows: Settings → Privacy & security → Camera / Microphone.",
};

const FAILURE_COPY: Record<MediaFailure, { title: string; hint: string; osPointer: boolean }> = {
  denied: {
    title: "Surveillance Equipment Compromised",
    hint: "The browser was refused access to your camera and microphone. Re-arm permissions in the address bar (camera icon), then retry.",
    osPointer: true,
  },
  "no-devices": {
    title: "No Equipment Detected",
    hint: "No camera or microphone was found on this machine. Connect your gear and retry.",
    osPointer: false,
  },
  unavailable: {
    title: "Equipment Malfunction",
    hint: "Your camera or microphone could not be started — another application may be holding it. Close it and retry.",
    osPointer: true,
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

// No native "session changed" event to subscribe to, and nothing on this page
// writes one — the no-op subscribe keeps the old mount effect's "read it, then
// follow React's own render schedule" behavior. The snapshot is a boolean, so
// it is referentially stable by value; the server one is false because the
// server render must never touch localStorage (see the comment at its use).
function noopSubscribe() {
  return () => {};
}
function getAuthedSnapshot(): boolean {
  return getSessionSnapshot() != null;
}
function getAuthedServerSnapshot(): boolean {
  return false;
}

export default function RoomPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("parsing");
  const [keys, setKeys] = useState<RoomKeys | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Derived from the store, NOT latched. The old `useState(false)` tracked
  // "have I clicked this during this page load" rather than "is this room my
  // studio", so walking into your own standing studio still offered to pin it
  // (found live 2026-08-05). Server snapshot is null — the SSR contract this
  // file already keeps for `authed`.
  const pinnedStudio = useSyncExternalStore(subscribeStudioRoom, readStudioRoomSnapshot, () => null);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [forceRelay, setForceRelay] = useState(false);
  const media = useLocalMedia(stage === "green-room" || stage === "in-room");
  const call = useCallSession(keys, media.stream, stage === "in-room", forceRelay);
  // The local speaking detector, run on the LOCAL stream. Unconditional
  // hook — safe to compute even before the room mounts (returns false with
  // no audio track). Its raw flicker never reaches a tile: the latch below
  // holds the outline on the most recent speaker until a DIFFERENT person
  // speaks (8/4 dress-rehearsal rework — no more per-word flashing).
  const selfSpeaking = useSpeaking(media.stream);
  const { lastSpeaker, noteSpeaker } = useSpeakerLatch(selfSpeaking);

  // Podcast mode is for logged-in hosts only; anonymous guests get the plain
  // call. Read through a store with a `false` server snapshot so the server
  // render never touches localStorage — React resyncs to the real value right
  // after hydration, the same flip the old mount effect produced.
  const authed = useSyncExternalStore(noopSubscribe, getAuthedSnapshot, getAuthedServerSnapshot);
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
    // liveDeviceIds, NOT `choice` — the same truth rule the pickers follow
    // (useLocalMedia's doc on `choice`: what was ASKED for). This value becomes
    // an `exact` deviceId constraint on the tape's own mic capture
    // (lib/podcast/recordGraph.ts), so a stored pick that never came up —
    // the mic was busy at join and the call quietly degraded to the default —
    // would record the WRONG microphone with no fault shown. Undefined is
    // safe: recordGraph omits the constraint and takes the default.
    audioDeviceId: media.liveDeviceIds.audioDeviceId,
    // eslint-disable-next-line react-hooks/refs -- the deliberate one-render-lag bridge documented above: usePodcastTake only ever reads holdRolls back out through holdRollsRef, from wire callbacks and user actions outside the render pass, so a value at most one commit stale is harmless and breaks the genuine two-hook cycle
    holdRolls: exchangeBusyRef.current,
  });
  // While the tape rolls the recorded tracks are frozen: no device toggles,
  // and the self tile shows the true recorded frame. `fault` stays in the
  // broad lock (exchange hold, call controls, honest crop) but NOT in the
  // device-bar lock below: in a fault the take is already compromised and a
  // device swap is the remedy — the 8/5 drill's unplugged camera left no
  // path to reselect one without rejoining.
  const takeInProgress =
    podcast.panel.kind === "countdown" ||
    podcast.panel.kind === "rolling" ||
    podcast.panel.kind === "stopping";
  const podcastLocked = takeInProgress || podcast.panel.kind === "fault";
  // …and the device bar keys on the take having been compromised, not on the
  // banner being on screen. `panel.kind === "fault"` only lasts until the
  // operator acknowledges the alarm — which is what the drill card told
  // Deanna to do at F1, dropping the panel back to "rolling" and re-locking
  // her out with the camera still unplugged (8/5 re-drill finding 2).
  // usePodcastTake latches faultedThisTake for the rest of the take instead.
  const deviceBarLocked = takeInProgress && !podcast.faultedThisTake;
  // Take provenance for the armed card's send affordance: until a reel has
  // actually rolled in THIS session, any sendable take is the restored
  // previous-session one (usePodcastTake re-reads it from localStorage on
  // mount for reload recovery), and the button must say so. Render-time
  // state adjustment (the documented "storing information from previous
  // renders" pattern) — latches once, never resets within the session.
  const [rolledThisSession, setRolledThisSession] = useState(false);
  if (
    !rolledThisSession &&
    (podcast.panel.kind === "rolling" || podcast.panel.kind === "stopping")
  ) {
    setRolledThisSession(true);
  }
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
  // eslint-disable-next-line react-hooks/refs -- the write half of that same one-render-lag bridge; nothing in this render's output reads it, and promoting it to state would close the two-hook cycle it exists to break
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one atomic mount-only read-and-destroy: the fragment carries the E2EE secret, so it is stashed and scrubbed from history in the same pass, and any later snapshot read would find an already-erased hash
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
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — CallControls' own button only knows "Copy
      // Invite"/"Link Secured ✓" (it's a component owned elsewhere), so the
      // visible signal lives here instead: the same role="alert" idiom this
      // file's sibling page (app/studio/page.tsx's uploadError/listError)
      // already uses for a failure the user needs to notice and act on.
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 2000);
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
    setReplaceArmed(false);
  }

  // Which of the three honest states the pin control is in. Compared on
  // roomId: the secret can be re-keyed for the same room without that making
  // it a different studio.
  const isThisRoomPinned = Boolean(keys && pinnedStudio?.roomId === keys.roomId);
  const replacesAnotherStudio = Boolean(pinnedStudio) && !isThisRoomPinned;

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
        {copy.osPointer && (
          <div className="hairline mx-auto mt-5 max-w-md border border-vermilion/40 bg-inset p-4 text-left">
            <p className="kicker text-vermilion">◈ {OS_POINTER.heading}</p>
            <p className="mt-2 font-body text-sm text-ink-soft">{OS_POINTER.intro}</p>
            <p className="mt-2 font-body text-sm text-ink-soft">{OS_POINTER.macOS}</p>
            <p className="font-body text-sm text-ink-soft">{OS_POINTER.windows}</p>
          </div>
        )}
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
            selectedId={media.liveDeviceIds.audioDeviceId}
            onSelect={(id) => void media.switchDevice("audio", id)}
          />
          <DevicePicker
            label="Camera"
            devices={media.devices.cameras}
            selectedId={media.liveDeviceIds.videoDeviceId}
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
          <div>
            {isThisRoomPinned ? (
              // Already yours — a statement with somewhere to go, not a dead
              // button. This is also what a fresh pin resolves to.
              <p className="kicker flex flex-wrap items-center justify-between gap-2 border border-brass/40 px-4 py-3 text-ink-soft">
                <span className="text-signal">✓ This is your standing studio</span>
                <Link href="/studio" className="transition hover:text-signal">
                  Studio ➔
                </Link>
              </p>
            ) : replaceArmed ? (
              // Two-step, because the stored secret is the only way back into
              // the studio being replaced.
              <div className="border border-vermilion/60 p-4">
                <p className="font-body text-sm text-ink">
                  ✕ This replaces{" "}
                  <span className="italic">{readStudioName() ?? "Standing Studio"}</span>. Its link
                  is the only way back in — keep it before you continue.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={pinStudio}
                    className="kicker border border-vermilion/60 px-4 py-2 text-vermilion transition hover:bg-vermilion hover:text-cream"
                  >
                    Replace it
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplaceArmed(false)}
                    className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal"
                  >
                    Keep {readStudioName() ?? "Standing Studio"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={replacesAnotherStudio ? () => setReplaceArmed(true) : pinStudio}
                  className="kicker w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
                >
                  {replacesAnotherStudio
                    ? "Make this my standing studio instead"
                    : "Make this my standing studio"}
                </button>
                <p className="mt-2 font-body text-xs italic text-ink-soft">
                  It waits for you under Studio — walk back in any time, with no invite link to dig
                  up.
                </p>
              </>
            )}
          </div>
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
  // phone. Height = 100svh minus the fixed chrome above this block — sticky
  // NavBar (py-4 + 1.5rem logo row ≈ 3.5rem) + main's top padding (py-12 =
  // 3rem) ≈ 6.5rem. 7rem is the measured-good value, not a derived one: the
  // e2e geometry assertion at 390×844 caught the 6.5rem estimate landing the
  // wrapper 8px below the fold, and where those 8px come from was never
  // pinned down. The footer intentionally falls below the fold in-call.
  // svh (small viewport height), not dvh: dvh grows/shrinks as the mobile
  // address bar retracts on scroll, which made the tiles jump size mid-call
  // (7/30 testers). svh is the stable chrome-visible height, so the grid
  // holds one size regardless of scroll. At a fixed 390×844 (headless e2e,
  // no retractable UA chrome) svh == dvh, so the pinned geometry is unchanged.
  const tileCount = 1 + Math.max(call.peers.length, 1);
  const gridClass =
    tileCount <= 2
      ? "grid-cols-1 grid-rows-[repeat(2,minmax(0,1fr))] sm:grid-cols-2 sm:grid-rows-[minmax(0,1fr)]"
      : "grid-cols-2 grid-rows-[repeat(2,minmax(0,1fr))]";

  return (
    <div className="flex h-[calc(100svh-7rem)] min-h-[20rem] flex-col gap-3">
      {authed && (
        <PodcastPanel
          state={(() => {
            const merged = mergePanel(podcast.panel, exchange);
            return merged.kind === "armed" && !rolledThisSession
              ? { ...merged, restoredTake: true }
              : merged;
          })()}
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
          speaking={lastSpeaker === SELF_SPEAKER}
          camOff={!media.camOn}
          micCut={!media.micOn}
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
            // While the tape rolls the composite crops both cameras — crop the
            // partner tile too so the preview is honest (CS-DR-04 2B).
            episodeFrame={podcastLocked}
            speaking={lastSpeaker === p.peerId}
            onSpeakingStart={noteSpeaker}
          />
        ))}
        {/* The empty seat's centre overlay already says "Awaiting agent" — the
            caption is the only line that can say what to DO about it, and it
            names the Copy Invite button two rows below (8/5 copy pass). */}
        {call.peers.length === 0 && (
          <VideoTile fill stream={null} label="Copy Invite to fill this seat" />
        )}
      </div>
      <InCallDeviceBar
        mics={media.devices.mics}
        cameras={media.devices.cameras}
        liveMicId={media.liveDeviceIds.audioDeviceId}
        liveCameraId={media.liveDeviceIds.videoDeviceId}
        hasCamera={media.hasCamera}
        locked={deviceBarLocked}
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
      {copyFailed && (
        <p role="alert" className="kicker text-vermilion">
          ✕ Clipboard blocked — copy the invite link manually.
        </p>
      )}
    </div>
  );
}
