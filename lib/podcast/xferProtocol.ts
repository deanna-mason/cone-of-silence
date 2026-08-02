// Episode-exchange wire frames + binary chunk envelope. Pure module: no I/O,
// no DOM. Wire frames are JSON with a "t" field prefixed "xfr/", mirroring
// takeProtocol.ts's "pod/" convention so both protocols can share a bus
// without colliding. The chunk envelope is the 5D switch (spec §5D
// "transfer envelope"): 5B always sends enc=0 with a zeroed IV; 5D flips
// enc=1, fills a per-chunk IV, and the payload becomes AES-GCM ciphertext —
// the frame layout itself never changes.
import type { SidecarEntry } from "./vault";

export const XFER_CHUNK_BYTES = 65_536; // <=64 KiB PLAINTEXT payload, safely under the 256 KiB SCTP message limit
export const XFER_HEADER_BYTES = 20;
export const OFFER_TIMEOUT_MS = 10_000;
// AES-GCM's fixed authentication tag overhead (frameCipher.ts's encryptFrame
// appends it after the ciphertext) — an enc=1 payload is up to this many
// bytes larger than the XFER_CHUNK_BYTES of plaintext it carries.
const GCM_TAG_BYTES = 16;

export interface FilePlan {
  base: "audio" | "video";
  parts: SidecarEntry[];
}

export type XferFrame =
  | { t: "xfr/offer"; v: 1; episodeId: string; from: string | null; files: FilePlan[] } // audio FIRST (spec)
  | { t: "xfr/have"; v: 1; episodeId: string; committed: string[] } // receiver's committed part names — THE resume state
  | { t: "xfr/part"; v: 1; episodeId: string; name: string; size: number; sha256: string; chunks: number }
  | { t: "xfr/part-committed"; v: 1; episodeId: string; name: string } // after hash-verify + atomic rename
  | { t: "xfr/done"; v: 1; episodeId: string } // after the manifest is on disk
  | { t: "xfr/fault"; v: 1; episodeId: string; reason: string };

/** "xfr/" t-prefix guard, mirrors takeProtocol's parseWireMsg. */
export function parseXferFrame(text: string): XferFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const t = (msg as { t?: unknown }).t;
  if (typeof t !== "string" || !t.startsWith("xfr/")) return null;
  return msg as XferFrame;
}

export function encodeFrame(frame: XferFrame): string {
  return JSON.stringify(frame);
}

/** Binary chunk envelope — the 5D switch (spec §5D "transfer envelope"):
 *  [u8 version=1][u8 enc: 0=plain, 1=aes-gcm][u16 reserved=0][u32 seq LE][12-byte IV]
 *  then the payload. 5B always sends enc=0 with a zeroed IV; 5D flips enc=1,
 *  fills the per-chunk IV, and the payload becomes AES-GCM ciphertext over the
 *  same plaintext — the frame layout NEVER changes. Carrying the full IV per
 *  chunk (rather than a counter convention) makes nonce reuse across rebuilds
 *  structurally impossible for 5D. */
export interface ChunkEnvelope {
  enc: 0 | 1;
  seq: number;
  iv: Uint8Array;
  payload: Uint8Array;
}

/** enc=0 path (5B) when `iv` is omitted; enc=1 path (5D) when a 12-byte `iv`
 *  is supplied. `payload` is always what goes out verbatim in the payload
 *  slot — for 5D that means CIPHERTEXT+TAG ONLY, never the IV again: the IV
 *  already has its own 12-byte slot in the header (bytes 8..19), so
 *  encryptFrame's [IV][ciphertext+tag] output must be split before calling
 *  this (the IV half goes here, the rest is `payload`) rather than passed
 *  through whole.
 *
 *  Post-5D (Task 6): the `iv`-omitted (enc=0) branch below has no production
 *  caller any more — EpisodeSender.pump() always supplies `iv`, and
 *  EpisodeReceiver refuses any enc=0 chunk outright (xferKey is a mandatory
 *  constructor dep now; there is no keyless mode to send a plain chunk
 *  from). It stays only so tests can synthesize the downgrade-attempt
 *  fixture that proves that refusal — do not read it as a live plaintext
 *  wire path. */
export function encodeChunk(seq: number, payload: Uint8Array, iv?: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(XFER_HEADER_BYTES + payload.length);
  const dv = new DataView(buf);
  dv.setUint8(0, 1); // version
  dv.setUint8(1, iv ? 1 : 0); // enc: 1 = aes-gcm (5D), 0 = plain (5B, test-only post-Task-6)
  dv.setUint16(2, 0, true); // reserved
  dv.setUint32(4, seq >>> 0, true); // seq, little-endian
  if (iv) {
    if (iv.length !== 12) throw new RangeError(`encodeChunk: iv must be exactly 12 bytes, got ${iv.length}`);
    new Uint8Array(buf, 8, 12).set(iv);
  } // else bytes 8..19 (IV) left zeroed — the enc=0 fixture path only (see doc comment above).
  new Uint8Array(buf, XFER_HEADER_BYTES).set(payload);
  return buf;
}

/** null = malformed/short/oversized/unknown version. */
export function decodeChunk(buf: ArrayBuffer): ChunkEnvelope | null {
  if (buf.byteLength < XFER_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  const version = dv.getUint8(0);
  if (version !== 1) return null;
  const enc = dv.getUint8(1);
  if (enc !== 0 && enc !== 1) return null;
  const seq = dv.getUint32(4, true);
  const iv = new Uint8Array(buf.slice(8, 20));
  const payload = new Uint8Array(buf.slice(XFER_HEADER_BYTES));
  // enc=1's payload is ciphertext+tag over up to XFER_CHUNK_BYTES of
  // plaintext, so its cap is 16 bytes higher than enc=0's plaintext cap —
  // widening this uniformly would let an enc=0 (plaintext) frame past the
  // real XFER_CHUNK_BYTES limit, which the (c) byte-layout tests pin.
  const maxPayload = enc === 1 ? XFER_CHUNK_BYTES + GCM_TAG_BYTES : XFER_CHUNK_BYTES;
  if (payload.length > maxPayload) return null;
  return { enc, seq, iv, payload };
}
