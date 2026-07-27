import { describe, expect, it } from "vitest";
import {
  SPEAKING_THRESHOLD,
  isSpeaking,
  rmsFromTimeDomain,
} from "@/lib/audioLevel";

// getByteTimeDomainData centers silence on 128.
const silence = new Uint8Array(256).fill(128);
const loud = new Uint8Array(256).map((_, i) => (i % 2 ? 208 : 48)); // ±0.625 square
const whisper = new Uint8Array(256).map((_, i) => (i % 2 ? 130 : 126)); // ±0.016

describe("rmsFromTimeDomain", () => {
  it("silence is zero", () => {
    expect(rmsFromTimeDomain(silence)).toBe(0);
  });

  it("a full square wave reads its amplitude", () => {
    expect(rmsFromTimeDomain(loud)).toBeCloseTo(0.625, 2);
  });
});

describe("isSpeaking", () => {
  it("loud speech crosses the default threshold; a whisper-level hum does not", () => {
    expect(isSpeaking(loud)).toBe(true);
    expect(isSpeaking(whisper)).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(isSpeaking(whisper, 0.01)).toBe(true);
    expect(SPEAKING_THRESHOLD).toBe(0.04);
  });
});
