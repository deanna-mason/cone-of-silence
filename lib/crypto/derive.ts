// lib/crypto/derive.ts
// Phase 5D: every room key (media, transfer, join-proof) comes from ONE
// never-sent secret — the URL-fragment token minted by lib/roomLink.ts and
// stashed in sessionStorage, never sent to the signaling server. HKDF-SHA-256
// spreads that 128-bit secret into three independent, purpose-bound,
// non-extractable WebCrypto keys so a leak of one derived key (impossible via
// the API anyway, since none of them are extractable) can't be turned into
// the others.

import { TOKEN_RE } from "../roomLink";
import { base64url } from "../base64url";

// Reports which check failed (length vs. charset) without ever touching the
// secret's own characters.
const CHARSET_RE = /^[A-Za-z0-9_-]*$/;

export interface RoomCryptoKeys {
  mediaKey: CryptoKey; // AES-GCM 256, encrypt|decrypt
  xferKey: CryptoKey; // AES-GCM 256, encrypt|decrypt
  proofKey: CryptoKey; // HMAC SHA-256, sign|verify
}

export const HKDF_SALT = "cos-5d-v1";
export const INFO_MEDIA = "cos/media";
export const INFO_XFER = "cos/xfer";
export const INFO_PROOF = "cos/proof";

/** base64url (22 chars, no padding) → 16 raw bytes. Throws TypeError on any
 * length/charset deviation from the room-secret wire format, or on a
 * non-canonical encoding. Error messages never include the secret's value —
 * it is never-sent key material and this may be surfaced by a caller's
 * logging or an error boundary. */
export function decodeSecret(secret: string): Uint8Array {
  if (!TOKEN_RE.test(secret)) {
    throw new TypeError(
      `decodeSecret: invalid room secret (length ${secret.length}, charset ${
        CHARSET_RE.test(secret) ? "ok" : "invalid"
      }) — expected 22-char base64url`,
    );
  }
  const std = secret.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // 22 base64url chars carry 132 bits for 128 bits (16 bytes) of real data —
  // the trailing 4 bits of the last character must be zero for a canonical
  // encoding, otherwise multiple distinct strings decode to the same bytes
  // (breaking the secret <-> encoding bijection every caller assumes).
  // Re-encoding and comparing is the simplest correct canonicality check.
  if (base64url(bytes) !== secret) {
    throw new TypeError("decodeSecret: non-canonical base64url encoding (trailing bits must be zero)");
  }
  return bytes;
}

function hkdfParams(info: string): HkdfParams {
  return {
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode(HKDF_SALT),
    info: new TextEncoder().encode(info),
  };
}

async function importHkdfKey(secret: string): Promise<CryptoKey> {
  const ikm = decodeSecret(secret);
  // decodeSecret always returns an ArrayBuffer-backed view (freshly allocated
  // above), never SharedArrayBuffer-backed — this cast just corrects TS
  // 5.7's conservative default Uint8Array<ArrayBufferLike> generic (same
  // idiom as lib/podcast/episodeStore.ts:127-134).
  return crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
}

/** Derives the three room keys from the shared secret in one pass. Every key
 * is non-extractable — rawIKM never leaves this function's stack, and no
 * derived key can be exported back out through the WebCrypto API. */
export async function deriveRoomKeys(secret: string): Promise<RoomCryptoKeys> {
  const hkdfKey = await importHkdfKey(secret);
  const [mediaKey, xferKey, proofKey] = await Promise.all([
    crypto.subtle.deriveKey(
      hkdfParams(INFO_MEDIA),
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      hkdfParams(INFO_XFER),
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      hkdfParams(INFO_PROOF),
      hkdfKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  ]);
  return { mediaKey, xferKey, proofKey };
}

/** Raw 32-byte HKDF output for a given info string — same salt/hash/IKM
 * derivation as deriveRoomKeys, exposed only so tests can pin vectors and
 * assert separation properties without reaching into opaque CryptoKeys. */
export async function deriveBitsForTest(secret: string, info: string): Promise<Uint8Array> {
  const hkdfKey = await importHkdfKey(secret);
  const bits = await crypto.subtle.deriveBits(hkdfParams(info), hkdfKey, 256);
  return new Uint8Array(bits);
}
