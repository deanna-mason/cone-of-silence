// @vitest-environment node
// Pure WebCrypto (HKDF-SHA-256, AES-GCM, HMAC) — no DOM needed, so this file
// runs under Node's native webcrypto rather than jsdom (the repo default).
import { describe, expect, it } from "vitest";
import { createRoomKeys } from "@/lib/roomLink";
import {
  HKDF_SALT,
  INFO_MEDIA,
  INFO_PROOF,
  INFO_XFER,
  decodeSecret,
  deriveBitsForTest,
  deriveRoomKeys,
} from "@/lib/crypto/derive";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("decodeSecret", () => {
  it("round-trips a real 16-byte secret produced by lib/roomLink.ts's createRoomKeys()", () => {
    const { secret } = createRoomKeys();
    const bytes = decodeSecret(secret);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });

  it("rejects bad length/charset (5 cases)", () => {
    const cases = [
      "", // empty
      "AAAAAAAAAAAAAAAAAAAAA", // 21 chars — one short
      "AAAAAAAAAAAAAAAAAAAAAAA", // 23 chars — one long
      "AAAAAAAAAAAAAAAAAAAAA+", // 22 chars but contains '+' (not base64url)
      "AAAAAAAAAAAAAAAAAAAAA=", // 22 chars but contains '=' (padding, must be absent)
    ];
    expect(cases).toHaveLength(5);
    for (const bad of cases) {
      expect(() => decodeSecret(bad)).toThrow(TypeError);
    }
  });

  it("never leaks the secret value in its error message (length/charset failure)", () => {
    // The room secret is never-sent key material — a thrown error crossing
    // an error boundary or landing in a log must not carry it. This marker
    // is deliberately distinctive so a substring leak would be obvious.
    const marker = "TOTALLY-SECRET-MARKER-VALUE-DO-NOT-LOG";
    let thrown: unknown;
    try {
      decodeSecret(marker);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).not.toContain(marker);
  });

  it("canonicality: rejects a non-canonical 22-char string whose trailing bits are nonzero, accepts its canonical sibling", () => {
    // Both strings are valid length-22 base64url and decode to the SAME 16
    // zero bytes (the last char's low 4 bits are unused padding for a
    // trailing single-byte group) — only the canonical one (trailing bits
    // all zero) may be accepted, or the secret<->encoding bijection breaks.
    const canonical = "AAAAAAAAAAAAAAAAAAAAAA"; // last char 'A' (value 0) — trailing bits zero
    const nonCanonical = "AAAAAAAAAAAAAAAAAAAAAB"; // last char 'B' (value 1) — trailing bits nonzero

    expect(() => decodeSecret(canonical)).not.toThrow();
    expect(() => decodeSecret(nonCanonical)).toThrow(TypeError);
  });

  it("never leaks the secret value in its error message (non-canonical failure)", () => {
    const nonCanonical = "AAAAAAAAAAAAAAAAAAAAAB";
    let thrown: unknown;
    try {
      decodeSecret(nonCanonical);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).not.toContain(nonCanonical);
  });
});

describe("deriveBitsForTest", () => {
  it("is deterministic: same secret+info → identical 32 bytes", async () => {
    const { secret } = createRoomKeys();
    const a = await deriveBitsForTest(secret, INFO_MEDIA);
    const b = await deriveBitsForTest(secret, INFO_MEDIA);
    expect(a.length).toBe(32);
    expect(toHex(a)).toBe(toHex(b));
  });

  it("different infos → different bits; different secrets → different bits", async () => {
    const { secret: secretA } = createRoomKeys();
    const { secret: secretB } = createRoomKeys();

    const media = await deriveBitsForTest(secretA, INFO_MEDIA);
    const xfer = await deriveBitsForTest(secretA, INFO_XFER);
    const proof = await deriveBitsForTest(secretA, INFO_PROOF);
    expect(toHex(media)).not.toBe(toHex(xfer));
    expect(toHex(media)).not.toBe(toHex(proof));
    expect(toHex(xfer)).not.toBe(toHex(proof));

    const otherSecretMedia = await deriveBitsForTest(secretB, INFO_MEDIA);
    expect(toHex(media)).not.toBe(toHex(otherSecretMedia));
  });

  // Vectors below pin HKDF_SALT + each INFO_* string forever: any change to
  // either breaks them on purpose. Each was computed ONCE, independently of
  // this module, via:
  //
  //   node -e '
  //   const { webcrypto } = require("crypto");
  //   const subtle = webcrypto.subtle;
  //   (async () => {
  //     const ikm = new Uint8Array(16); // decodeSecret("AAAA...AAAA") — 16 zero bytes
  //     const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  //     const salt = new TextEncoder().encode("cos-5d-v1");
  //     for (const info of ["cos/media", "cos/xfer", "cos/proof"]) {
  //       const bits = await subtle.deriveBits(
  //         { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
  //         key, 256,
  //       );
  //       console.log(info, Buffer.from(bits).toString("hex"));
  //     }
  //   })();
  //   '
  const ZERO_SECRET = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 chars → 16 zero bytes

  it("PINNED VECTOR: secret 'AAAAAAAAAAAAAAAAAAAAAA' (16 zero bytes) + 'cos/media'", async () => {
    expect(HKDF_SALT).toBe("cos-5d-v1");
    const bits = await deriveBitsForTest(ZERO_SECRET, INFO_MEDIA);
    expect(toHex(bits)).toBe("a0beb9259019ac17cf77615e90daec8ad934175de7721bd874dbaa3bca80181e");
  });

  it("PINNED VECTOR: secret 'AAAAAAAAAAAAAAAAAAAAAA' (16 zero bytes) + 'cos/xfer'", async () => {
    const bits = await deriveBitsForTest(ZERO_SECRET, INFO_XFER);
    expect(toHex(bits)).toBe("9830c3547c8db17d2817e2b07ec71648b5c4c30092d110d084b749aa095d9160");
  });

  it("PINNED VECTOR: secret 'AAAAAAAAAAAAAAAAAAAAAA' (16 zero bytes) + 'cos/proof'", async () => {
    const bits = await deriveBitsForTest(ZERO_SECRET, INFO_PROOF);
    expect(toHex(bits)).toBe("d552f69701c6f56eae1a3a13fc9fb99399584f6f4782752fa04ee18256223f65");
  });
});

describe("deriveRoomKeys", () => {
  it("returns non-extractable keys with exactly the right algorithms/usages", async () => {
    const { secret } = createRoomKeys();
    const keys = await deriveRoomKeys(secret);

    expect(keys.mediaKey.extractable).toBe(false);
    expect(keys.mediaKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect([...keys.mediaKey.usages].sort()).toEqual(["decrypt", "encrypt"]);

    expect(keys.xferKey.extractable).toBe(false);
    expect(keys.xferKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect([...keys.xferKey.usages].sort()).toEqual(["decrypt", "encrypt"]);

    expect(keys.proofKey.extractable).toBe(false);
    expect(keys.proofKey.algorithm).toMatchObject({ name: "HMAC", hash: { name: "SHA-256" } });
    expect([...keys.proofKey.usages].sort()).toEqual(["sign", "verify"]);
  });

  it("different secrets never collide across all three derived keys' underlying bits", async () => {
    const { secret: secretA } = createRoomKeys();
    const { secret: secretB } = createRoomKeys();
    const a = await Promise.all([
      deriveBitsForTest(secretA, INFO_MEDIA),
      deriveBitsForTest(secretA, INFO_XFER),
      deriveBitsForTest(secretA, INFO_PROOF),
    ]);
    const b = await Promise.all([
      deriveBitsForTest(secretB, INFO_MEDIA),
      deriveBitsForTest(secretB, INFO_XFER),
      deriveBitsForTest(secretB, INFO_PROOF),
    ]);
    for (let i = 0; i < 3; i++) expect(toHex(a[i]!)).not.toBe(toHex(b[i]!));
  });
});
