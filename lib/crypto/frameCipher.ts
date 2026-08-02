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

/** Realm-agnostic "is this actually an ArrayBuffer" check. `instanceof
 * ArrayBuffer` compares against the CALLING module's own realm's
 * constructor — verified empirically here: a `TextEncoder().encode(x).buffer`
 * built while this module runs under vitest's default jsdom environment
 * fails `instanceof ArrayBuffer` even though it is a completely genuine
 * ArrayBuffer (from a different vm realm), which would make an `instanceof`
 * guard reject legitimate callers, not just bad ones — exactly the
 * cross-realm gap __tests__/vault.test.ts:8-18 documents for
 * Blob.arrayBuffer(). Object.prototype.toString reads the object's internal
 * [[Class]] slot instead of walking a realm-specific prototype chain, so it
 * correctly accepts an ArrayBuffer from ANY realm while still rejecting
 * null/undefined/a DataView/a bare Uint8Array — see encryptFrame's guard. */
function isArrayBuffer(x: unknown): x is ArrayBuffer {
  return Object.prototype.toString.call(x) === "[object ArrayBuffer]";
}

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
 * why sharing/rebuilding it incorrectly is a nonce-reuse hazard. Throws
 * TypeError on non-ArrayBuffer input (see the guard below) — unlike
 * decryptFrame, this function must never fail closed: a caller error here
 * should be loud, not silently produce a well-formed, wrong ciphertext. */
export async function encryptFrame(key: CryptoKey, iv: IvState, data: ArrayBuffer): Promise<ArrayBuffer> {
  // `new Uint8Array(data)` below COERCES rather than validates — for
  // null/undefined/a DataView it silently yields a well-formed, ZERO-LENGTH
  // view instead of throwing, which would turn a caller bug into a
  // successfully-encrypted frame containing no plaintext at all. Guarding
  // explicitly here (same fail-loud intent as decryptFrame's own
  // `instanceof ArrayBuffer` check fails closed to null) keeps a bad call an
  // error rather than wrong output — but a plain `instanceof ArrayBuffer`
  // here would ALSO reject the legitimate cross-realm ArrayBuffers this
  // module already has to tolerate (see isArrayBuffer's own doc), so this
  // uses the realm-agnostic check instead.
  if (!isArrayBuffer(data)) {
    throw new TypeError("encryptFrame: data must be an ArrayBuffer");
  }
  const nonce = iv.next();
  // Fed as a Uint8Array VIEW, not the bare ArrayBuffer, on purpose: an
  // ArrayBuffer constructed inside jsdom (a separate vm realm from Node's
  // native WebCrypto implementation) fails the realm-specific
  // `instanceof ArrayBuffer` check crypto.subtle.encrypt's webidl argument
  // coercion runs internally — exactly the cross-realm gap
  // __tests__/vault.test.ts:8-18 already documents for Blob.arrayBuffer().
  // ArrayBuffer.isView() (what a TypedArray view satisfies) is realm-agnostic,
  // so wrapping here is a no-op in a real single-realm browser but is what
  // makes this callable from a jsdom-environment test at all. Only
  // use-episode-exchange.test.tsx genuinely needs jsdom (it renders a hook
  // via @testing-library/react); the Task 6 engine-fixture suites
  // (episode-receiver/-sender/episode-exchange-loopback.test.ts) run under
  // jsdom too only because they didn't opt into the repo's
  // `// @vitest-environment node` docblock — this wrap is what lets them work
  // either way, rather than this module requiring the node-only pragma
  // everywhere it's exercised. Same reasoning below in decryptFrame.
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
