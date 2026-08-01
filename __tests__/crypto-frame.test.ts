// @vitest-environment node
// Pure WebCrypto (AES-GCM) — no DOM needed, so this file runs under Node's
// native webcrypto rather than jsdom (the repo default). Real keys come from
// Task 1's deriveRoomKeys, not mocks — this cipher is only as trustworthy as
// the (key, nonce) pairs it feeds AES-GCM, so tests exercise the actual
// derivation path a caller would use.
import { describe, expect, it } from "vitest";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";
import { IvState, decryptFrame, encryptFrame } from "@/lib/crypto/frameCipher";

async function testKey(): Promise<CryptoKey> {
  const { secret } = createRoomKeys();
  const { mediaKey } = await deriveRoomKeys(secret);
  return mediaKey;
}

describe("IvState", () => {
  it("two IvStates have different prefixes (regeneration property, 32-bit random)", () => {
    const a = new IvState();
    const b = new IvState();
    expect(a.prefix).toBeInstanceOf(Uint8Array);
    expect(a.prefix.length).toBe(4);
    expect(b.prefix.length).toBe(4);
    expect(Array.from(a.prefix)).not.toEqual(Array.from(b.prefix));
  });

  it("prefix is exposed and read-only at the type level", () => {
    const iv = new IvState();
    expect(iv.prefix).toBeInstanceOf(Uint8Array);
    // @ts-expect-error prefix is readonly — reassignment must fail to compile
    iv.prefix = new Uint8Array(4);
  });

  it("counter is big-endian starting at 0, incrementing by 1 (byte-exact, not just unique)", () => {
    const iv = new IvState();
    const first = iv.next();
    const second = iv.next();
    const third = iv.next();
    expect(Array.from(first.slice(4))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(second.slice(4))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(third.slice(4))).toEqual([0, 0, 0, 0, 0, 0, 0, 2]);
    // prefix rides every frame unchanged
    expect(Array.from(first.slice(0, 4))).toEqual(Array.from(iv.prefix));
    expect(Array.from(second.slice(0, 4))).toEqual(Array.from(iv.prefix));
    expect(Array.from(third.slice(0, 4))).toEqual(Array.from(iv.prefix));
  });

  it("counter rolls a full byte big-endian (256 calls), not little-endian", () => {
    const iv = new IvState();
    let last = iv.next();
    for (let i = 1; i < 256; i++) last = iv.next();
    // the 256th call (i=0..255) produced counter value 255
    expect(Array.from(last.slice(4))).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
    const next = iv.next();
    // counter value 256 => big-endian carries into the second-to-last byte
    expect(Array.from(next.slice(4))).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
  });

  it("counter increments per next(); 12-byte IVs never repeat across 1000 frames", () => {
    const iv = new IvState();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const nonce = iv.next();
      expect(nonce.length).toBe(12);
      const key = Array.from(nonce).join(",");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("encryptFrame / decryptFrame", () => {
  it("round-trips 0-byte, 1-byte, and 64KiB frames", async () => {
    const key = await testKey();
    for (const len of [0, 1, 64 * 1024]) {
      const iv = new IvState();
      const plaintext = crypto.getRandomValues(new Uint8Array(len));
      const wire = await encryptFrame(key, iv, plaintext.buffer);
      const out = await decryptFrame(key, wire);
      expect(out).not.toBeNull();
      expect(Array.from(new Uint8Array(out as ArrayBuffer))).toEqual(Array.from(plaintext));
    }
  });

  it("output layout: first 12 bytes are IV; total = 12 + len + 16", async () => {
    const key = await testKey();
    const iv = new IvState();
    const plaintext = new Uint8Array(100);
    const wire = await encryptFrame(key, iv, plaintext.buffer);
    expect(wire.byteLength).toBe(12 + 100 + 16);
    const gotIvPrefix = new Uint8Array(wire, 0, 4);
    expect(Array.from(gotIvPrefix)).toEqual(Array.from(iv.prefix));
    // counter for this, the first, frame is 0
    const gotCounter = new Uint8Array(wire, 4, 8);
    expect(Array.from(gotCounter)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("tamper any single byte (IV prefix, IV counter, body, tag) → decryptFrame returns null", async () => {
    const key = await testKey();
    const iv = new IvState();
    const plaintext = new TextEncoder().encode("the cone of silence is on");
    const wire = await encryptFrame(key, iv, plaintext.buffer);
    const bytes = new Uint8Array(wire);

    // sanity: the untampered frame round-trips
    expect(await decryptFrame(key, wire)).not.toBeNull();

    const positions = [0, 6, 12, bytes.length - 1]; // IV prefix / IV counter / first ciphertext byte / last tag byte
    for (const pos of positions) {
      const tampered = bytes.slice();
      tampered[pos] ^= 0xff;
      const result = await decryptFrame(key, tampered.buffer);
      expect(result).toBeNull();
    }
  });

  it("wrong key → null; truncated (<13 bytes) → null; never throws", async () => {
    const key = await testKey();
    const wrongKey = await testKey();
    const iv = new IvState();
    const plaintext = new TextEncoder().encode("hello");
    const wire = await encryptFrame(key, iv, plaintext.buffer);

    await expect(decryptFrame(wrongKey, wire)).resolves.toBeNull();

    for (const len of [0, 1, 11, 12]) {
      await expect(decryptFrame(key, new ArrayBuffer(len))).resolves.toBeNull();
    }
  });

  it("decryptFrame never throws, even on inputs that violate the ArrayBuffer contract", async () => {
    const key = await testKey();
    const malformed: unknown[] = [null, undefined, "not a buffer", 42, {}, new Uint8Array(50)];
    for (const bad of malformed) {
      await expect(decryptFrame(key, bad as ArrayBuffer)).resolves.toBeNull();
    }
  });
});
