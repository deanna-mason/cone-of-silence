import { describe, expect, it } from "vitest";
import type { SidecarEntry } from "@/lib/podcast/vault";
import {
  OFFER_TIMEOUT_MS,
  XFER_CHUNK_BYTES,
  XFER_HEADER_BYTES,
  decodeChunk,
  encodeChunk,
  encodeFrame,
  parseXferFrame,
  type FilePlan,
  type XferFrame,
} from "@/lib/podcast/xferProtocol";

const part: SidecarEntry = { name: "audio.part000", size: 12_345, sha256: "ab".repeat(32) };
const audioPlan: FilePlan = { base: "audio", parts: [part] };
const videoPlan: FilePlan = { base: "video", parts: [part] };

describe("xferProtocol constants", () => {
  it("matches the spec verbatim", () => {
    expect(XFER_CHUNK_BYTES).toBe(65_536);
    expect(XFER_HEADER_BYTES).toBe(20);
    expect(OFFER_TIMEOUT_MS).toBe(10_000);
  });
});

describe("frame round-trip (a)", () => {
  const cases: XferFrame[] = [
    { t: "xfr/offer", v: 1, episodeId: "ep-1", from: "alice", files: [audioPlan, videoPlan] },
    { t: "xfr/offer", v: 1, episodeId: "ep-1", from: null, files: [audioPlan, videoPlan] },
    { t: "xfr/have", v: 1, episodeId: "ep-1", committed: ["audio.part000", "video.part000"] },
    { t: "xfr/have", v: 1, episodeId: "ep-1", committed: [] },
    { t: "xfr/part", v: 1, episodeId: "ep-1", name: "audio.part000", size: 12_345, sha256: "ab".repeat(32), chunks: 3 },
    { t: "xfr/part-committed", v: 1, episodeId: "ep-1", name: "audio.part000" },
    { t: "xfr/done", v: 1, episodeId: "ep-1" },
    { t: "xfr/fault", v: 1, episodeId: "ep-1", reason: "hash mismatch" },
  ];

  for (const frame of cases) {
    it(`round-trips ${frame.t}`, () => {
      const text = encodeFrame(frame);
      expect(typeof text).toBe("string");
      const parsed = parseXferFrame(text);
      expect(parsed).toEqual(frame);
    });
  }
});

describe("parseXferFrame rejects non-xfr traffic (b)", () => {
  it("rejects 5A pod/ frames", () => {
    expect(parseXferFrame(JSON.stringify({ t: "pod/hello", codename: "otter" }))).toBeNull();
  });

  it("rejects garbage JSON text", () => {
    expect(parseXferFrame("not json at all {{{")).toBeNull();
  });

  it("rejects well-formed JSON with no t field", () => {
    expect(parseXferFrame(JSON.stringify({ episodeId: "ep-1" }))).toBeNull();
  });

  it("rejects a t field that isn't a string", () => {
    expect(parseXferFrame(JSON.stringify({ t: 42 }))).toBeNull();
  });

  it("rejects non-object JSON (array, string, number, null)", () => {
    expect(parseXferFrame(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseXferFrame(JSON.stringify("xfr/done"))).toBeNull();
    expect(parseXferFrame(JSON.stringify(42))).toBeNull();
    expect(parseXferFrame(JSON.stringify(null))).toBeNull();
  });
});

describe("encodeChunk byte layout (c)", () => {
  it("lays out the header exactly per spec, for a non-trivial seq and payload", () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const seq = 0x01020304;
    const buf = encodeChunk(seq, payload);
    expect(buf.byteLength).toBe(XFER_HEADER_BYTES + payload.length);

    const dv = new DataView(buf);
    expect(dv.getUint8(0)).toBe(1); // version
    expect(dv.getUint8(1)).toBe(0); // enc = plain (5B)
    expect(dv.getUint16(2, true)).toBe(0); // reserved
    expect(dv.getUint32(4, true)).toBe(seq); // seq, little-endian

    const iv = new Uint8Array(buf, 8, 12);
    expect(iv).toEqual(new Uint8Array(12)); // zeroed IV in 5B

    const payloadOut = new Uint8Array(buf, 20);
    expect(payloadOut).toEqual(payload);
  });

  it("handles a zero-length payload", () => {
    const buf = encodeChunk(0, new Uint8Array(0));
    expect(buf.byteLength).toBe(XFER_HEADER_BYTES);
  });
});

describe("decodeChunk round-trip (d)", () => {
  it("decodes what encodeChunk produced", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const buf = encodeChunk(42, payload);
    const env = decodeChunk(buf);
    expect(env).not.toBeNull();
    expect(env!.enc).toBe(0);
    expect(env!.seq).toBe(42);
    expect(env!.iv).toEqual(new Uint8Array(12));
    expect(env!.payload).toEqual(payload);
  });

  it("round-trips a max-size payload", () => {
    const payload = new Uint8Array(XFER_CHUNK_BYTES).fill(7);
    const buf = encodeChunk(1, payload);
    const env = decodeChunk(buf);
    expect(env).not.toBeNull();
    expect(env!.payload).toEqual(payload);
  });
});

describe("decodeChunk decodes the 5D enc=1 contract intact (e)", () => {
  it("decodes enc=1 with a nonzero IV preserved", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const buf = new ArrayBuffer(XFER_HEADER_BYTES + payload.length);
    const dv = new DataView(buf);
    dv.setUint8(0, 1); // version
    dv.setUint8(1, 1); // enc = aes-gcm
    dv.setUint16(2, 0, true); // reserved
    dv.setUint32(4, 7, true); // seq
    new Uint8Array(buf, 8, 12).set(iv);
    new Uint8Array(buf, 20).set(payload);

    const env = decodeChunk(buf);
    expect(env).not.toBeNull();
    expect(env!.enc).toBe(1);
    expect(env!.seq).toBe(7);
    expect(env!.iv).toEqual(iv);
    expect(env!.payload).toEqual(payload);
  });
});

describe("decodeChunk rejects malformed input (f)", () => {
  it("rejects a buffer shorter than the header", () => {
    expect(decodeChunk(new ArrayBuffer(19))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(decodeChunk(new ArrayBuffer(0))).toBeNull();
  });

  it("rejects a payload larger than XFER_CHUNK_BYTES", () => {
    const buf = encodeChunk(1, new Uint8Array(XFER_CHUNK_BYTES + 1));
    expect(decodeChunk(buf)).toBeNull();
  });

  it("rejects an unknown version", () => {
    const buf = encodeChunk(1, new Uint8Array([1, 2, 3]));
    new DataView(buf).setUint8(0, 2);
    expect(decodeChunk(buf)).toBeNull();
  });

  it("rejects version 0", () => {
    const buf = encodeChunk(1, new Uint8Array([1, 2, 3]));
    new DataView(buf).setUint8(0, 0);
    expect(decodeChunk(buf)).toBeNull();
  });
});
