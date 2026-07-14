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

export interface LocalMedia {
  stream: MediaStream | null;
  devices: DeviceLists;
  choice: MediaDeviceChoice;
  micOn: boolean;
  camOn: boolean;
  hasCamera: boolean;
  failure: MediaFailure | null;
  switchDevice: (kind: "audio" | "video", deviceId: string) => Promise<void>;
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

  async function switchDevice(kind: "audio" | "video", deviceId: string): Promise<void> {
    const gen = ++switchGen.current;
    const keepMicOn = micOn;
    const keepCamOn = camOn;
    const next: MediaDeviceChoice = {
      ...choiceRef.current,
      [kind === "audio" ? "audioDeviceId" : "videoDeviceId"]: deviceId,
    };
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
    micOn,
    camOn,
    hasCamera: stream !== null && stream.getVideoTracks().length > 0,
    failure,
    switchDevice,
    toggleMic,
    toggleCam,
    retry,
    stop,
  };
}
