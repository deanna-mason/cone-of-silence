// hooks/useLocalMedia.ts
// Local-media lifecycle extracted from app/room/page.tsx (Phase 2 carry-over):
// acquisition, device switching, mute/cam toggles, teardown. Never touches
// the network — signaling/peer state lives in useCallSession.
"use client";

import { useEffect, useRef, useState } from "react";
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

/** The devices the capture is ACTUALLY on, read off the live tracks. Distinct
 *  from `choice`, which is only what was asked for: an unplugged camera ends
 *  its track without any re-acquire, and getLocalStream's audio-only degrade
 *  can return a stream that honours no videoDeviceId at all. Undefined means
 *  "cannot say" — never a guess. */
export interface LiveDeviceIds {
  audioDeviceId?: string;
  videoDeviceId?: string;
}

function readLiveDeviceIds(stream: MediaStream | null): LiveDeviceIds {
  const idOf = (track: MediaStreamTrack | undefined): string | undefined => {
    if (!track || track.readyState !== "live") return undefined;
    // Safari has shipped getSettings() without a deviceId; a blank id is
    // "unknown", which the picker renders as nothing selected.
    return track.getSettings?.().deviceId || undefined;
  };
  if (!stream) return {};
  return {
    audioDeviceId: idOf(stream.getAudioTracks()[0]),
    videoDeviceId: idOf(stream.getVideoTracks()[0]),
  };
}

export interface LocalMedia {
  stream: MediaStream | null;
  devices: DeviceLists;
  /** What was *asked for*. For what is actually live, use liveDeviceIds. */
  choice: MediaDeviceChoice;
  liveDeviceIds: LiveDeviceIds;
  micOn: boolean;
  camOn: boolean;
  hasCamera: boolean;
  failure: MediaFailure | null;
  switchDevice: (kind: "audio" | "video", deviceId: string) => Promise<void>;
  /** Phone front/back flip: toggles facingMode (user⇄environment) and drops
   *  any explicit camera choice, since a deviceId names one physical camera.
   *  Re-acquires like switchDevice — mute state preserved, old track released. */
  flipCamera: () => Promise<void>;
  toggleMic: () => void;
  toggleCam: () => void;
  retry: () => void;
  stop: () => void;
}

export function useLocalMedia(enabled: boolean): LocalMedia {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<DeviceLists>({ mics: [], cameras: [] });
  const [choice, setChoice] = useState<MediaDeviceChoice>({});
  const choiceRef = useRef<MediaDeviceChoice>({});
  const switchGen = useRef(0);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  const [liveDeviceIds, setLiveDeviceIds] = useState<LiveDeviceIds>({});

  // Acquire when enabled (kept across green-room ⇄ in-room; `failure: null`
  // in the deps means retry() re-triggers acquisition by clearing it).
  useEffect(() => {
    if (!enabled || streamRef.current || failure) return;
    let cancelled = false;
    const stored = readStashedDeviceChoice();
    choiceRef.current = stored;
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
        if (!cancelled) setFailure(err instanceof MediaError ? err.reason : "unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, failure]);

  // Belt-and-braces: stop tracks if the consumer unmounts any other way.
  useEffect(() => {
    return () => {
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  // Keep the picker lists live (8/5 drill: an unplugged Continuity Camera
  // left a ghost entry and a replug never appeared, so there was no path to
  // reselect a camera without rejoining). Display-list refresh only — no
  // stream lifecycle is touched here.
  useEffect(() => {
    if (!enabled) return;
    const md: MediaDevices | undefined = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    let cancelled = false;
    const refresh = () => {
      // Belt and braces for finding 4: a Continuity Camera is not guaranteed
      // to fire `ended` on its track when the phone drops off, but devicechange
      // fires either way — so re-read what is live here too, not just the list.
      setLiveDeviceIds(readLiveDeviceIds(streamRef.current));
      void listDevices().then((lists) => {
        if (!cancelled) setDevices(lists);
      });
    };
    md.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      md.removeEventListener("devicechange", refresh);
    };
  }, [enabled]);

  // Track what the capture is actually on (8/5 re-drill, finding 4). A track
  // that ends — camera unplugged mid-call — changes no React state of its own,
  // so subscribe to `ended` and re-read; otherwise the pickers would go on
  // naming a camera that stopped running.
  useEffect(() => {
    const read = () => setLiveDeviceIds(readLiveDeviceIds(stream));
    read();
    if (!stream) return;
    const tracks = stream.getTracks();
    tracks.forEach((t) => t.addEventListener?.("ended", read));
    return () => tracks.forEach((t) => t.removeEventListener?.("ended", read));
  }, [stream]);

  // Shared re-acquire behind switchDevice/flipCamera: swap to `next`, keep the
  // live mute state, release the old capture, and drop any stream a newer
  // re-acquire has already superseded (switchGen). The stream state change
  // propagates to the mesh via useCallSession's setLocalStream effect — no
  // renegotiation, tracks are replaced in place.
  async function reacquire(next: MediaDeviceChoice): Promise<void> {
    const gen = ++switchGen.current;
    const keepMicOn = micOn;
    const keepCamOn = camOn;
    choiceRef.current = next;
    setChoice(next);
    stashDeviceChoice(next);
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    try {
      const s = await getLocalStream(next);
      if (switchGen.current !== gen) {
        // a newer switch superseded this one — don't leak its stream
        stopStream(s);
        return;
      }
      s.getAudioTracks().forEach((t) => (t.enabled = keepMicOn));
      s.getVideoTracks().forEach((t) => (t.enabled = keepCamOn));
      streamRef.current = s;
      setStream(s);
      setMicOn(keepMicOn);
      setCamOn(keepCamOn && s.getVideoTracks().length > 0);
    } catch (err) {
      if (switchGen.current !== gen) return;
      setFailure(err instanceof MediaError ? err.reason : "unavailable");
    }
  }

  async function switchDevice(kind: "audio" | "video", deviceId: string): Promise<void> {
    // An explicit camera pick names one physical device — drop any facingMode
    // (they'd conflict); an explicit mic pick leaves the camera choice as-is.
    const next: MediaDeviceChoice =
      kind === "audio"
        ? { ...choiceRef.current, audioDeviceId: deviceId }
        : { ...choiceRef.current, videoDeviceId: deviceId, facingMode: undefined };
    await reacquire(next);
  }

  async function flipCamera(): Promise<void> {
    const current = choiceRef.current.facingMode ?? "user";
    const next: MediaDeviceChoice = {
      ...choiceRef.current,
      facingMode: current === "user" ? "environment" : "user",
      videoDeviceId: undefined,
    };
    await reacquire(next);
  }

  function toggleMic(): void {
    const s = streamRef.current;
    if (!s) return;
    const next = !micOn;
    s.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }

  function toggleCam(): void {
    const s = streamRef.current;
    // recorded minor from the Phase 1 review: no video track → nothing to toggle
    if (!s || s.getVideoTracks().length === 0) return;
    const next = !camOn;
    s.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  }

  function retry(): void {
    setFailure(null); // clearing failure re-triggers the acquisition effect
  }

  function stop(): void {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }

  return {
    stream,
    devices,
    choice,
    liveDeviceIds,
    micOn,
    camOn,
    hasCamera: stream !== null && stream.getVideoTracks().length > 0,
    failure,
    switchDevice,
    flipCamera,
    toggleMic,
    toggleCam,
    retry,
    stop,
  };
}
