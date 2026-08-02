// lib/crypto/frameCipher.ts
// Phase 5D: per-frame AES-GCM for media (and, per D17, xfer chunk payloads).
// Nonce rule (load-bearing, see docs/superpowers/plans/2026-08-01-phase-5d-e2ee.md
// Global Constraints): a 96-bit IV = 32-bit random per-construction prefix +
// 64-bit frame counter. The prefix is drawn fresh every time an IvState is
// constructed; the counter starts at 0 and only ever increments for that
// instance's lifetime. Reusing a (key, nonce) pair is a catastrophic AES-GCM
// break (full plaintext-XOR and forgery capability), so IvState is the ONLY
// thing in this module allowed to hand out an IV, and it never repeats one.

// BigInt literals (`0n`) require ES2020+; the repo targets ES2017, so every
// bigint here is constructed via BigInt(...) instead.
const MAX_COUNTER = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Per-construction IV state: fresh random 4-byte prefix, monotonic 8-byte
 * big-endian counter. One instance per encrypt pipe (worker transform, xfer
 * sender) — never share an instance's counter across independent pipes, and
 * never rebuild one with a stashed counter (a fresh construction always
 * means a fresh prefix, by design, so an accidental counter reset can't
 * collide with a previous instance's nonces). */
export class IvState {
  readonly prefix: Uint8Array;
  private counter = BigInt(0);

  constructor() {
    this.prefix = crypto.getRandomValues(new Uint8Array(4));
  }

  /** Returns the next 12-byte IV (prefix ‖ big-endian counter) and advances
   * the counter. Throws once the counter would wrap past 2^64-1 — silently
   * wrapping would reuse a nonce against this instance's fixed prefix. */
  next(): Uint8Array<ArrayBuffer> {
    if (this.counter > MAX_COUNTER) {
      throw new RangeError(
        "IvState: counter exhausted (2^64 frames encrypted under one prefix) — " +
          "refusing to wrap and reuse a (key, nonce) pair",
      );
    }
    const iv = new Uint8Array(12);
    iv.set(this.prefix, 0);
    new DataView(iv.buffer).setBigUint64(4, this.counter, false); // false = big-endian
    this.counter += BigInt(1);
    return iv;
  }
}

/** Encrypts one frame. Wire layout (D17): [12-byte IV][ciphertext ‖ 16-byte
 * GCM tag]. `iv` must be the pipe's single IvState — see the class doc for
 * why sharing/rebuilding it incorrectly is a nonce-reuse hazard. */
export async function encryptFrame(key: CryptoKey, iv: IvState, data: ArrayBuffer): Promise<ArrayBuffer> {
  const nonce = iv.next();
  // Fed as a Uint8Array VIEW, not the bare ArrayBuffer, on purpose: a test
  // harness running under jsdom (a separate vm realm from Node's native
  // WebCrypto implementation) constructs `data` with jsdom's own
  // ArrayBuffer constructor, and `instanceof ArrayBuffer` checks inside
  // Node's webidl argument coercion are realm-specific and reject it —
  // exactly the cross-realm hazard __tests__/vault.test.ts already documents
  // for Blob.arrayBuffer(). ArrayBuffer.isView() (what a TypedArray view
  // satisfies) is realm-agnostic, so wrapping here is a no-op in a real
  // single-realm browser but makes this function actually testable under
  // jsdom too. Same reasoning below in decryptFrame.
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new Uint8Array(data));
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out.buffer;
}

/** Decrypts one frame produced by encryptFrame. Fails closed: ANY problem —
 * input too short to hold an IV, a bad/tampered tag, a mismatched key, or
 * even a caller passing something that isn't really an ArrayBuffer — yields
 * `null`, never a thrown exception. The worker's per-frame pipeline relies on
 * that: a bad frame is dropped (black tile), not a crashed pipe. */
export async function decryptFrame(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer | null> {
  try {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 12) return null;
    const iv = new Uint8Array(data, 0, 12);
    // A view over the SAME buffer (not .slice()'s copy-into-a-bare-ArrayBuffer)
    // — see encryptFrame's comment on why a view, not a bare ArrayBuffer,
    // crosses the jsdom/Node-webcrypto realm boundary cleanly.
    const ciphertext = new Uint8Array(data, 12);
    return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    return null;
  }
}
