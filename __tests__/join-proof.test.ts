// @vitest-environment node
// Task 3 (Phase 5D): mutual join-proof state machine. Pure-crypto module, no
// DOM needed — same reasoning as crypto-frame.test.ts. Two real JoinProof
// instances are driven against each other over a hand-wired in-memory "bus"
// (the loopback-harness idiom from episode-exchange-loopback.test.ts, scaled
// down to this module's much simpler two-message protocol); keys come from
// the real deriveRoomKeys (Task 1), not mocks — this state machine is only as
// trustworthy as the HMACs it actually verifies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";
import { JoinProof, parseProofMsg, type ProofEvents, type ProofPhase } from "@/lib/webrtc/joinProof";
import {
  Mesh,
  RESTART_RECOVERY_MS,
  STAGGER_MS,
  type LinkEvents,
  type MeshLink,
  type RemotePeer,
} from "@/lib/webrtc/mesh";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Records every event and, once `target` is set, forwards each outgoing
 *  wire message straight into the other side's handleMessage — the two-way
 *  "bus" a real cos channel would provide. `target` is assigned after both
 *  JoinProof instances exist (each needs its own events object at
 *  construction, before the other instance is available to wire to). */
class BusEvents implements ProofEvents {
  sent: string[] = [];
  provenCount = 0;
  failedReasons: Array<"bad-mac" | "timeout"> = [];
  target: JoinProof | null = null;

  onSend(text: string): void {
    this.sent.push(text);
    this.target?.handleMessage(text);
  }
  onProven(): void {
    this.provenCount += 1;
  }
  onFailed(reason: "bad-mac" | "timeout"): void {
    this.failedReasons.push(reason);
  }
}

async function makePair(
  proofKeyA: CryptoKey,
  proofKeyB: CryptoKey,
  aId = "peer-a",
  bId = "peer-b",
): Promise<{ a: JoinProof; b: JoinProof; aEvents: BusEvents; bEvents: BusEvents }> {
  const aEvents = new BusEvents();
  const bEvents = new BusEvents();
  const a = new JoinProof({ proofKey: proofKeyA, selfPeerId: aId, remotePeerId: bId, events: aEvents });
  const b = new JoinProof({ proofKey: proofKeyB, selfPeerId: bId, remotePeerId: aId, events: bEvents });
  aEvents.target = b;
  bEvents.target = a;
  return { a, b, aEvents, bEvents };
}

/** One real macrotask tick — the mac computations under test are real
 *  crypto.subtle HMAC calls, which (like crypto.subtle.digest elsewhere in
 *  this suite) resolve through Node's genuine async crypto machinery rather
 *  than a single microtask turn. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("waitFor: condition not met within maxTicks");
}

/** Deterministic setTimeout/clearTimeout replacement for the timeout tests:
 *  fire() invokes (and clears) every still-pending timer exactly once, so a
 *  cancelled timer provably never runs. */
class FakeClock {
  private nextId = 1;
  private timers = new Map<number, () => void>();

  setTimeoutFn = ((fn: () => void) => {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  clearTimeoutFn = ((id: unknown) => {
    this.timers.delete(id as number);
  }) as typeof clearTimeout;

  fire(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

async function twoKeys(): Promise<{ keyA: CryptoKey; keyB: CryptoKey }> {
  const { secret: secretA } = createRoomKeys();
  const { secret: secretB } = createRoomKeys();
  const { proofKey: keyA } = await deriveRoomKeys(secretA);
  const { proofKey: keyB } = await deriveRoomKeys(secretB);
  return { keyA, keyB };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("JoinProof", () => {
  it("two honest peers: both reach proven; exactly one challenge+response each way", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const { a, b, aEvents, bEvents } = await makePair(proofKey, proofKey);

    a.start();
    b.start();
    await waitFor(() => a.phase === "proven" && b.phase === "proven");

    expect(a.phase).toBe<ProofPhase>("proven");
    expect(b.phase).toBe<ProofPhase>("proven");
    expect(aEvents.provenCount).toBe(1);
    expect(bEvents.provenCount).toBe(1);
    expect(aEvents.failedReasons).toEqual([]);
    expect(bEvents.failedReasons).toEqual([]);

    const aChallenges = aEvents.sent.filter((t) => parseProofMsg(t)?.t === "prf/challenge");
    const aResponses = aEvents.sent.filter((t) => parseProofMsg(t)?.t === "prf/response");
    const bChallenges = bEvents.sent.filter((t) => parseProofMsg(t)?.t === "prf/challenge");
    const bResponses = bEvents.sent.filter((t) => parseProofMsg(t)?.t === "prf/response");
    expect(aChallenges).toHaveLength(1);
    expect(aResponses).toHaveLength(1);
    expect(bChallenges).toHaveLength(1);
    expect(bResponses).toHaveLength(1);
  });

  it("wrong secret (different proofKey) → bad-mac failure on BOTH honest verifiers", async () => {
    const { keyA, keyB } = await twoKeys();
    const { a, b, aEvents, bEvents } = await makePair(keyA, keyB);

    a.start();
    b.start();
    await waitFor(() => a.phase === "failed" && b.phase === "failed");

    expect(aEvents.failedReasons).toEqual(["bad-mac"]);
    expect(bEvents.failedReasons).toEqual(["bad-mac"]);
    expect(aEvents.provenCount).toBe(0);
    expect(bEvents.provenCount).toBe(0);
  });

  it("reflection: echoing a peer's own response mac back → failed (mac binds responder id)", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const events = new BusEvents();
    const a = new JoinProof({ proofKey, selfPeerId: "peer-a", remotePeerId: "peer-b", events });

    a.start();
    expect(events.sent).toHaveLength(1);
    const challenge = parseProofMsg(events.sent[0]!);
    expect(challenge?.t).toBe("prf/challenge");
    const ownNonce = (challenge as { nonce: string }).nonce;

    // The "attacker": reflect A's own challenge back at A, with the SAME
    // nonce, as though it were a challenge from B. A auto-answers any
    // incoming challenge (it has to, for the mutual handshake to work when
    // messages interleave) — but the mac it computes is bound to A's OWN
    // peerId as responder, since A really is the one answering.
    a.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: ownNonce }));
    // Finding 4: this used to be a single fixed `await flush()` (one
    // macrotask tick) before asserting `sent` grew to 2. answerChallenge's
    // mac is a REAL crypto.subtle.sign call, which does not always resolve
    // within one tick under Node's genuine async crypto machinery (observed
    // flaky: 3/5 runs) — the fix is to await the actual dispatched work
    // settling (sent reaching length 2), not to guess a turn count, exactly
    // like every phase-transition wait elsewhere in this file already does.
    await waitFor(() => events.sent.length === 2);
    expect(events.sent).toHaveLength(2);
    const reflectedResponse = parseProofMsg(events.sent[1]!);
    expect(reflectedResponse?.t).toBe("prf/response");

    // Now replay that exact response back to A as if it were B's answer to
    // A's own outstanding challenge (nonce matches). If the mac didn't bind
    // the responder id, this would verify — it doesn't, because the mac was
    // computed with responderPeerId = "peer-a", but A's verifier expects
    // responderPeerId = "peer-b" (the remote it's actually talking to).
    a.handleMessage(events.sent[1]!);
    await waitFor(() => a.phase === "failed");

    expect(events.failedReasons).toEqual(["bad-mac"]);
    expect(events.provenCount).toBe(0);
  });

  it("replay: response with a stale/foreign nonce ignored, timeout → failed", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const events = new BusEvents();
    const clock = new FakeClock();
    const a = new JoinProof({
      proofKey,
      selfPeerId: "peer-a",
      remotePeerId: "peer-b",
      events,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    a.start();

    // A stale response: well-formed, but its nonce matches neither A's
    // outstanding challenge nor anything A ever issued — a foreign/replayed
    // message. It must be silently ignored (consumed as a recognized prf/*
    // message, but no phase change, no bad-mac failure).
    const consumed = a.handleMessage(JSON.stringify({ t: "prf/response", nonce: "not-the-real-nonce-abc", mac: "bogus" }));
    await flush();

    expect(consumed).toBe(true);
    expect(a.phase).toBe<ProofPhase>("pending");
    expect(events.failedReasons).toEqual([]);

    // Nothing valid ever arrives — the armed timeout is what finally fails it.
    clock.fire();

    expect(a.phase).toBe<ProofPhase>("failed");
    expect(events.failedReasons).toEqual(["timeout"]);
  });

  it("timeout with silence → failed('timeout') via injected fake timers", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const events = new BusEvents();
    const clock = new FakeClock();
    const a = new JoinProof({
      proofKey,
      selfPeerId: "peer-a",
      remotePeerId: "peer-b",
      events,
      timeoutMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    a.start();
    expect(a.phase).toBe<ProofPhase>("pending");
    expect(clock.pendingCount()).toBe(1);

    clock.fire();

    expect(a.phase).toBe<ProofPhase>("failed");
    expect(events.failedReasons).toEqual(["timeout"]);
    expect(events.provenCount).toBe(0);

    // Firing again (nothing pending) must not double-fire onFailed.
    clock.fire();
    expect(events.failedReasons).toEqual(["timeout"]);
  });

  it("foreign t / malformed JSON → handleMessage returns false, phase unchanged", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const events = new BusEvents();
    const a = new JoinProof({ proofKey, selfPeerId: "peer-a", remotePeerId: "peer-b", events });
    a.start();
    const sentBefore = events.sent.length;

    expect(a.handleMessage("not json at all")).toBe(false);
    expect(a.handleMessage(JSON.stringify({ t: "pod/hello", codename: "static-otter" }))).toBe(false);
    expect(a.handleMessage(JSON.stringify({}))).toBe(false);
    expect(a.handleMessage(JSON.stringify({ t: "prf/challenge" }))).toBe(false); // missing nonce
    expect(a.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: 42 }))).toBe(false); // wrong type
    expect(a.handleMessage(JSON.stringify({ t: "prf/response", nonce: "x" }))).toBe(false); // missing mac
    expect(a.handleMessage(JSON.stringify({ t: "prf/response", nonce: "x", mac: 1 }))).toBe(false); // wrong type
    await flush();

    expect(a.phase).toBe<ProofPhase>("pending");
    expect(events.sent.length).toBe(sentBefore); // no side effects from any of these
    expect(events.failedReasons).toEqual([]);
    expect(events.provenCount).toBe(0);
  });

  it("dispose cancels the timeout; no events after dispose", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const events = new BusEvents();
    const clock = new FakeClock();
    const a = new JoinProof({
      proofKey,
      selfPeerId: "peer-a",
      remotePeerId: "peer-b",
      events,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    a.start();
    expect(clock.pendingCount()).toBe(1);

    a.dispose();
    expect(clock.pendingCount()).toBe(0); // dispose cancelled the armed timeout

    clock.fire(); // hygiene: nothing pending, must be a no-op regardless
    expect(events.failedReasons).toEqual([]);

    const sentBefore = events.sent.length;

    // A well-formed challenge and a well-formed (if bogus) response arriving
    // post-dispose must not produce any event — dispose is a hard stop.
    a.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }));
    a.handleMessage(JSON.stringify({ t: "prf/response", nonce: "AAAAAAAAAAAAAAAAAAAAAA", mac: "bogus" }));
    await flush();

    expect(events.sent.length).toBe(sentBefore);
    expect(events.provenCount).toBe(0);
    expect(events.failedReasons).toEqual([]);
  });

  describe("parseProofMsg", () => {
    // 22-char base64url — the real wire format (16 random bytes). "abc"/"def"
    // used to round-trip here too, back when parseProofMsg didn't validate
    // nonce shape at all; now that it does (finding 1a), a well-formed test
    // fixture has to actually look like a wire nonce.
    const VALID_NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
    const OTHER_VALID_NONCE = "BBBBBBBBBBBBBBBBBBBBBB";

    it("parses well-formed challenge and response messages", () => {
      expect(parseProofMsg(JSON.stringify({ t: "prf/challenge", nonce: VALID_NONCE }))).toEqual({
        t: "prf/challenge",
        nonce: VALID_NONCE,
      });
      expect(parseProofMsg(JSON.stringify({ t: "prf/response", nonce: OTHER_VALID_NONCE, mac: "def" }))).toEqual({
        t: "prf/response",
        nonce: OTHER_VALID_NONCE,
        mac: "def",
      });
    });

    it("rejects malformed input without throwing (5 cases)", () => {
      expect(parseProofMsg("{not json")).toBeNull();
      expect(parseProofMsg("null")).toBeNull();
      expect(parseProofMsg('"a string"')).toBeNull();
      expect(parseProofMsg(JSON.stringify({ t: "prf/unknown" }))).toBeNull();
      expect(parseProofMsg(JSON.stringify({ nonce: VALID_NONCE }))).toBeNull(); // no t at all
    });

    // --- finding 1a: nonce format is itself pre-auth attack surface -------
    it("rejects a nonce that doesn't match the 22-char base64url wire format (oversized/short/non-charset)", () => {
      const oversized = "A".repeat(1_000_000); // the DoS-amplification shape from the reviewer's PoC
      const short = "AAAAAAAAAAAAAAAAAAAAA"; // 21 chars
      const long22Plus = "AAAAAAAAAAAAAAAAAAAAAAA"; // 23 chars
      const badCharset = "!!!!!!!!!!!!!!!!!!!!!!"; // 22 chars, wrong charset
      for (const nonce of [oversized, short, long22Plus, badCharset]) {
        expect(parseProofMsg(JSON.stringify({ t: "prf/challenge", nonce }))).toBeNull();
        expect(parseProofMsg(JSON.stringify({ t: "prf/response", nonce, mac: "whatever" }))).toBeNull();
      }
    });
  });

  // ---------------------------------------------------------------------
  // finding 1: answerChallenge canonicalization bypass — RED-first regression
  // ---------------------------------------------------------------------
  describe("finding 1 — pre-auth signing oracle / canonicalization bypass", () => {
    it("constructor rejects selfPeerId === remotePeerId (degenerate self-challenge)", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const events = new BusEvents();
      expect(() => new JoinProof({ proofKey, selfPeerId: "same-id", remotePeerId: "same-id", events })).toThrow();
    });

    it("canonicalization PoC: attacker peerId + crafted nonce must NOT let a victim compute a mac the victim's own verifier would accept", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const victimId = "victim-honest-peer-id";
      const W = "WWWWWWWW"; // attacker-chosen prefix the attacker folds into its own peerId
      const atkId = W + victimId; // atkId = W ‖ victimId, exactly the PoC's construction

      const victimEvents = new BusEvents();
      const victim = new JoinProof({ proofKey, selfPeerId: victimId, remotePeerId: atkId, events: victimEvents });

      victim.start();
      const challengeMsg = parseProofMsg(victimEvents.sent[0]!);
      expect(challengeMsg?.t).toBe("prf/challenge");
      const realNonce = (challengeMsg as { nonce: string }).nonce; // this is victim's OWN outstanding-challenge nonce, N

      // The attack: challenge the victim with nonce' = N ‖ W. If macInput
      // were still a bare, unprefixed concatenation, the victim's answer —
      // HMAC(nonce' ‖ victimId ‖ "resp") = HMAC(N ‖ W ‖ victimId ‖ "resp")
      // — would be byte-identical to HMAC(N ‖ atkId ‖ "resp"), which is
      // exactly what the victim's OWN verifyResponse expects as the answer
      // to its real challenge N. The attacker would just have to relay the
      // victim's own crafted-challenge response back as though it were
      // atkId's answer — full bypass, no key knowledge needed.
      const craftedNonce = realNonce + W;
      const consumed = victim.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: craftedNonce }));
      await flush();

      // Post-fix: craftedNonce is 22 + W.length chars — it fails the 22-char
      // wire-format check in parseProofMsg outright, so handleMessage never
      // even reaches answerChallenge. Nothing is forged: sent stays at 1
      // (just the real challenge), and the (structurally impossible, now)
      // reflected/forged response is never produced for the attacker to
      // relay back.
      expect(consumed).toBe(false);
      expect(victimEvents.sent).toHaveLength(1);
      expect(victim.phase).toBe<ProofPhase>("pending");
    });
  });

  // ---------------------------------------------------------------------
  // re-review follow-up (Task 3 re-review, item 2): the canonicalization PoC
  // above never actually reaches macInput — its crafted 30-char nonce dies at
  // NONCE_RE in parseProofMsg first. That means the length-prefixed layout in
  // macInput (the actual insurance against a future peerId-shape change in
  // server/src/rooms/registry.ts) had no test that would break if someone
  // reverted macInput to a bare, unprefixed concatenation. This pins the
  // exact wire mac for one fixed (secret, nonce, responderPeerId) triple, so
  // that layout is now locked byte-for-byte, same methodology as the pinned
  // HKDF vectors in __tests__/crypto-derive.test.ts: driven only through the
  // public API (answerChallenge's real crypto.subtle.sign call), compared
  // against a value computed ONCE, independently, via:
  //
  //   node -e '
  //   const { webcrypto } = require("crypto");
  //   const subtle = webcrypto.subtle;
  //   (async () => {
  //     const ikm = new Uint8Array(16); // decodeSecret("AAAA...AAAA") -> 16 zero bytes
  //     const hkdfKey = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
  //     const salt = new TextEncoder().encode("cos-5d-v1");
  //     const info = new TextEncoder().encode("cos/proof");
  //     const proofKey = await subtle.deriveKey(
  //       { name: "HKDF", hash: "SHA-256", salt, info },
  //       hkdfKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  //     );
  //     function u32be(n) {
  //       const out = new Uint8Array(4);
  //       new DataView(out.buffer).setUint32(0, n, false);
  //       return out;
  //     }
  //     function base64url(bytes) {
  //       return Buffer.from(bytes).toString("base64")
  //         .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  //     }
  //     const nonce = "B".repeat(22);
  //     const responderPeerId = "peer-vector-fixed-id";
  //     const enc = new TextEncoder();
  //     const nonceBytes = enc.encode(nonce);
  //     const idBytes = enc.encode(responderPeerId);
  //     const label = enc.encode("resp");
  //     const parts = [u32be(nonceBytes.length), nonceBytes, u32be(idBytes.length), idBytes, label];
  //     const total = parts.reduce((n, p) => n + p.length, 0);
  //     const macInput = new Uint8Array(total);
  //     let offset = 0;
  //     for (const p of parts) { macInput.set(p, offset); offset += p.length; }
  //     const sig = await subtle.sign("HMAC", proofKey, macInput);
  //     console.log(base64url(new Uint8Array(sig)));
  //   })();
  //   '
  //
  // Verified RED/GREEN by hand: temporarily reverting macInput to the old
  // bare `enc(nonce) ++ enc(responderPeerId) ++ enc("resp")` concatenation
  // made this test (and only this test) fail; restoring the length-prefixed
  // version made it pass again, with the rest of the suite unaffected either
  // way — see task-3-report.md for the transcript.
  describe("pinned MAC vector — locks the length-prefixed macInput layout", () => {
    it("fixed secret + fixed nonce + fixed responderPeerId → exact known mac", async () => {
      const ZERO_SECRET = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 chars -> 16 zero bytes, same fixture as crypto-derive.test.ts
      const NONCE = "B".repeat(22); // fixed 22-char base64url wire nonce
      const RESPONDER_ID = "peer-vector-fixed-id";
      const EXPECTED_MAC = "okI1iW3LE3nMrauSYM4A9JnfOUYwIS1OCkD5XvA-g68";

      const { proofKey } = await deriveRoomKeys(ZERO_SECRET);
      const events = new BusEvents();
      // RESPONDER_ID is this instance's OWN id: answerChallenge signs the
      // mac over `selfPeerId` (the module's responder-id binding), so this
      // is the side that must be `RESPONDER_ID`, challenged from some other,
      // arbitrary remote.
      const responder = new JoinProof({
        proofKey,
        selfPeerId: RESPONDER_ID,
        remotePeerId: "peer-vector-other-id",
        events,
      });

      responder.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: NONCE }));
      await waitFor(() => events.sent.length === 1);

      const response = parseProofMsg(events.sent[0]!);
      expect(response?.t).toBe("prf/response");
      expect((response as { mac: string }).mac).toBe(EXPECTED_MAC);
    });
  });

  // ---------------------------------------------------------------------
  // finding 3: the absorbing-state guards are correct today but were
  // previously untested — a future refactor moving a `_phase` write across
  // an `await` would have passed all prior tests. These pin the exact
  // races the reviewer verified by inspection.
  // ---------------------------------------------------------------------
  describe("finding 3 — race guards", () => {
    it("a bad response arriving after proven leaves phase proven, fires no onFailed", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const { a, b, aEvents, bEvents } = await makePair(proofKey, proofKey);
      a.start();
      b.start();
      await waitFor(() => a.phase === "proven" && b.phase === "proven");
      void bEvents; // only needed to drive the handshake to completion

      const provenBefore = aEvents.provenCount;
      // Well-formed but bogus, arriving after A is already proven.
      // verifyResponse's very first guard (`_phase !== "pending"`) fires
      // before it ever touches the nonce or crypto, so this cannot move A
      // off "proven" regardless of content.
      a.handleMessage(JSON.stringify({ t: "prf/response", nonce: "AAAAAAAAAAAAAAAAAAAAAA", mac: "bogus" }));
      await flush();

      expect(a.phase).toBe<ProofPhase>("proven");
      expect(aEvents.provenCount).toBe(provenBefore);
      expect(aEvents.failedReasons).toEqual([]);
    });

    it("a timeout firing while a verification is in flight yields exactly one event, not two", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const clock = new FakeClock();
      const events = new BusEvents();
      const a = new JoinProof({
        proofKey,
        selfPeerId: "peer-a",
        remotePeerId: "peer-b",
        events,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      });
      a.start();
      const nonce = (parseProofMsg(events.sent[0]!) as { nonce: string }).nonce;

      // A separate, real peer-b instance computes the genuine correct
      // response to A's challenge (shared proofKey, as it would be
      // room-wide) — captured on its own events object so the test
      // controls exactly when it's delivered to `a`.
      const bEvents = new BusEvents();
      const b = new JoinProof({ proofKey, selfPeerId: "peer-b", remotePeerId: "peer-a", events: bEvents });
      b.handleMessage(JSON.stringify({ t: "prf/challenge", nonce }));
      await waitFor(() => bEvents.sent.length === 1);
      const genuineResponse = bEvents.sent[0]!;

      // Deliver the genuine response — this dispatches verifyResponse,
      // which starts an in-flight crypto.subtle.sign call but has not yet
      // resolved.
      a.handleMessage(genuineResponse);
      // Fire the timeout SYNCHRONOUSLY, before that sign call can resolve:
      // FakeClock.fire() invokes the pending callback (fail("timeout"))
      // immediately, in this same synchronous turn.
      clock.fire();
      expect(a.phase).toBe<ProofPhase>("failed");
      expect(events.failedReasons).toEqual(["timeout"]);

      // Let the in-flight verifyResponse's computeMac actually settle now.
      // Its post-await guard (`this._phase !== "pending"`) must see
      // "failed" and return without ever calling onProven.
      await flush();
      expect(a.phase).toBe<ProofPhase>("failed");
      expect(events.provenCount).toBe(0);
      expect(events.failedReasons).toEqual(["timeout"]);
    });

    it("a concurrent good and bad response settle exactly once (settle order may vary, event count may not)", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const events = new BusEvents();
      const a = new JoinProof({ proofKey, selfPeerId: "peer-a", remotePeerId: "peer-b", events });
      a.start();
      const nonce = (parseProofMsg(events.sent[0]!) as { nonce: string }).nonce;

      const bEvents = new BusEvents();
      const b = new JoinProof({ proofKey, selfPeerId: "peer-b", remotePeerId: "peer-a", events: bEvents });
      b.handleMessage(JSON.stringify({ t: "prf/challenge", nonce }));
      await waitFor(() => bEvents.sent.length === 1);
      const genuineResponse = bEvents.sent[0]!;
      const badResponse = JSON.stringify({ t: "prf/response", nonce, mac: "definitely-not-the-real-mac" });

      // Dispatch both in the same synchronous turn: both verifyResponse
      // calls start their own independent computeMac before either
      // resolves — a genuine race, not a manufactured ordering.
      a.handleMessage(badResponse);
      a.handleMessage(genuineResponse);
      await waitFor(() => a.phase !== "pending");
      await flush(); // let the loser's computeMac drain too, whichever it is

      // Whichever call settles first wins; the loser's post-await guard is
      // a no-op either way (a bad mac can only fail to veto trust, never
      // create it — see the comment in verifyResponse). The invariant is
      // that EXACTLY one terminal event ever fires: never zero, never two.
      const totalEvents = events.provenCount + events.failedReasons.length;
      expect(totalEvents).toBe(1);
      if (events.provenCount === 1) {
        expect(a.phase).toBe<ProofPhase>("proven");
      } else {
        expect(a.phase).toBe<ProofPhase>("failed");
        expect(events.failedReasons).toEqual(["bad-mac"]);
      }
    });

    it("cross-peer splice: relaying a genuinely-signed response from a THIRD peer to A → bad-mac, never proven", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret); // shared room-wide proofKey, as it would be in practice
      const aEvents = new BusEvents();
      const a = new JoinProof({ proofKey, selfPeerId: "peer-a", remotePeerId: "peer-b", events: aEvents });
      a.start();
      const nonce = (parseProofMsg(aEvents.sent[0]!) as { nonce: string }).nonce;

      // C is a real, honest THIRD peer that never claims to be B — it just
      // happens to be fed a (relayed) challenge carrying A's own nonce, and
      // answers it honestly as itself.
      const cEvents = new BusEvents();
      const c = new JoinProof({ proofKey, selfPeerId: "peer-c", remotePeerId: "peer-x", events: cEvents });
      c.handleMessage(JSON.stringify({ t: "prf/challenge", nonce }));
      await waitFor(() => cEvents.sent.length === 1);
      const splicedResponse = cEvents.sent[0]!; // mac is bound to responderPeerId = "peer-c"

      a.handleMessage(splicedResponse);
      await waitFor(() => a.phase === "failed");

      expect(aEvents.failedReasons).toEqual(["bad-mac"]);
      expect(aEvents.provenCount).toBe(0);
    });

    it("start() called twice: no double-send, no double-arm of the timeout", async () => {
      const { secret } = createRoomKeys();
      const { proofKey } = await deriveRoomKeys(secret);
      const events = new BusEvents();
      const clock = new FakeClock();
      const a = new JoinProof({
        proofKey,
        selfPeerId: "peer-a",
        remotePeerId: "peer-b",
        events,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
      });

      a.start();
      expect(events.sent).toHaveLength(1);
      expect(clock.pendingCount()).toBe(1);
      const firstNonce = (parseProofMsg(events.sent[0]!) as { nonce: string }).nonce;

      a.start(); // second call — must be a complete no-op

      expect(events.sent).toHaveLength(1);
      expect(clock.pendingCount()).toBe(1);
      // Re-issuing the challenge on the second call would invalidate the
      // nonce an in-flight honest response is answering — confirm the
      // ORIGINAL nonce (and therefore the original armed timer) is still the
      // live one by actually answering it: a genuine peer-b response keyed
      // to firstNonce must still verify and reach "proven". If the second
      // start() call had silently re-armed a different nonce, verifyResponse
      // would reject this as stale/foreign and `a` would instead time out.
      const bEvents = new BusEvents();
      const b = new JoinProof({ proofKey, selfPeerId: "peer-b", remotePeerId: "peer-a", events: bEvents });
      b.handleMessage(JSON.stringify({ t: "prf/challenge", nonce: firstNonce }));
      await waitFor(() => bEvents.sent.length === 1);
      a.handleMessage(bEvents.sent[0]!);
      await waitFor(() => a.phase !== "pending");
      expect(a.phase).toBe<ProofPhase>("proven");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 5: proof gating wired at the Mesh/session layer
// ---------------------------------------------------------------------------
// The security property under test: until a peer is proven, NOTHING from it
// reaches the app — no messages in or out, no remote stream, not visible in
// the roster/participant count. The harness below (FakeLink + GatingHarness)
// mirrors lib/webrtc/session.ts's CallSession.buildLink/checkCountersignFailed
// wiring against a REAL Mesh with real JoinProof instances (real HMAC, same
// as every other test in this file) — the mesh/session fakes idiom, scaled
// up from mesh.test.ts's FakeLink harness. Keep this wiring in sync with
// session.ts if that shape ever changes; it is deliberately a close mirror,
// not an abstraction session.ts itself imports (session.ts has to interleave
// this with real SignalingClient/PeerLink/Worker wiring the mesh-only
// harness here doesn't need).
//
// Mesh's own construction/recovery timers (STAGGER_MS, RESTART_RECOVERY_MS)
// are NOT injectable, so the rebuild test needs real fake timers — but the
// join-proof handshake underneath is genuine crypto.subtle HMAC (same as
// every other test above), which resolves via Node's real async machinery,
// not a fake-timer tick. vitest 4's *Async timer APIs are built for exactly
// this mix: they yield to the microtask queue between each virtual tick, so
// a real pending crypto.subtle promise still gets to resolve.
describe("join-proof gating (Task 5) — the Mesh/session wiring", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class FakeLink implements MeshLink {
    sent: string[] = [];
    closeCalls = 0;
    /** Set by GatingHarness#wireTo — stands in for the real cos channel
     *  carrying this link's outbound bytes to the other side's inbound feed. */
    onSendHook: ((text: string) => void) | null = null;
    handleSignal = vi.fn(async (_payload: string) => {});
    replaceStream = vi.fn(async (_stream: MediaStream) => {});
    restartIce = vi.fn();
    close = vi.fn(() => {
      this.closeCalls += 1;
    });
    send = vi.fn((text: string) => {
      this.sent.push(text);
      this.onSendHook?.(text);
      return true;
    });
    sendXfer = vi.fn(() => true);
    xferBufferedAmount = vi.fn(() => 0);
  }

  interface PeerHandle {
    link: FakeLink;
    proof: JoinProof;
    polite: boolean;
    openChannel: () => void;
    deliverMessage: (text: string) => void;
    deliverStream: (stream: MediaStream) => void;
    setConnectionState: (state: RTCPeerConnectionState) => void;
  }

  class GatingHarness {
    readonly mesh: Mesh;
    readonly deliveredMessages: Array<[string, string]> = [];
    countersignFailedCount = 0;
    private readonly rosters: RemotePeer[][] = [];
    private readonly peers = new Map<string, PeerHandle>();

    constructor(
      private readonly selfPeerId: string,
      private readonly proofKeyFor: (peerId: string) => CryptoKey,
    ) {
      this.mesh = new Mesh(
        (peerId, polite, ev) => this.buildLink(peerId, polite, ev),
        {
          onRoster: (r) => this.rosters.push(r),
          onChannelOpen: () => {},
          onChannelClosed: () => {},
          onMessage: (peerId, text) => this.deliveredMessages.push([peerId, text]),
          onChannelState: () => {},
          onXferMessage: () => {},
          onXferDrain: () => {},
        },
      );
    }

    /** Latest roster snapshot — [] before the first emit, same as a fresh CallSession. */
    get roster(): RemotePeer[] {
      return this.rosters.at(-1) ?? [];
    }

    linkFor(peerId: string): FakeLink {
      return this.peers.get(peerId)!.link;
    }

    proofPhaseOf(peerId: string): ProofPhase {
      return this.peers.get(peerId)!.proof.phase;
    }

    /** Cos-channel-open rising edge — starts (or, on a fresh post-rebuild
     *  link, restarts) the join-proof, exactly like session.ts's onChannelOpen. */
    openChannel(peerId: string): void {
      this.peers.get(peerId)!.openChannel();
    }

    /** Feeds one inbound wire message exactly like a real "cos" onmessage. */
    deliverMessage(peerId: string, text: string): void {
      this.peers.get(peerId)!.deliverMessage(text);
    }

    deliverStream(peerId: string, stream: MediaStream): void {
      this.peers.get(peerId)!.deliverStream(stream);
    }

    setConnectionState(peerId: string, state: RTCPeerConnectionState): void {
      this.peers.get(peerId)!.setConnectionState(state);
    }

    /** Wires this peer's outbound sends straight into `other`'s inbound feed
     *  for `otherSideId` — the two-harness loopback standing in for a real
     *  cos channel between two CallSessions. Re-call after a rebuild: the
     *  fresh FakeLink is a new object, so the hook needs re-attaching (a
     *  real cos channel doesn't have this problem — it's the same wire). */
    wireTo(peerId: string, other: GatingHarness, otherSideId: string): void {
      this.linkFor(peerId).onSendHook = (text) => other.deliverMessage(otherSideId, text);
    }

    /** Mirrors CallSession.leave()/dropAll's proof cleanup. */
    disposeAllProofs(): void {
      for (const p of this.peers.values()) p.proof.dispose();
    }

    // Mirrors lib/webrtc/session.ts's CallSession.buildLink almost verbatim
    // (see this describe block's header comment) — one JoinProof per remote
    // peer, fresh every time this runs (initial construction AND every 4C
    // rebuild), gating onMessage/onRemoteStream/roster via mesh.setProven.
    private buildLink(peerId: string, polite: boolean, ev: LinkEvents): FakeLink {
      this.peers.get(peerId)?.proof.dispose(); // a prior proof for this SAME peerId (rebuild) must not linger
      this.mesh.setProven(peerId, false); // fresh link ⇒ fresh rising edge, re-arm unconditionally

      const link = new FakeLink();
      let stashedStream: MediaStream | null = null;
      const proofEvents: ProofEvents = {
        onSend: (text) => {
          link.send(text);
        },
        onProven: () => {
          this.mesh.setProven(peerId, true);
          if (stashedStream) {
            const stream = stashedStream;
            stashedStream = null;
            ev.onRemoteStream(stream);
          }
        },
        onFailed: () => {
          this.mesh.setProven(peerId, false);
          link.close();
          this.checkCountersignFailed();
        },
      };
      const proof = new JoinProof({
        proofKey: this.proofKeyFor(peerId),
        selfPeerId: this.selfPeerId,
        remotePeerId: peerId,
        events: proofEvents,
      });
      this.peers.set(peerId, {
        link,
        proof,
        polite,
        openChannel: () => {
          ev.onChannelOpen();
          proof.start();
        },
        deliverMessage: (text) => {
          if (proof.handleMessage(text)) return; // prf/* — consumed, never forwarded
          if (proof.phase === "proven") ev.onMessage(text);
          // else: dropped, not queued.
        },
        deliverStream: (stream) => {
          if (proof.phase === "proven") ev.onRemoteStream(stream);
          else stashedStream = stream;
        },
        setConnectionState: (state) => ev.onConnectionState(state),
      });
      return link;
    }

    // D18's asymmetry, purely from local information — see session.ts's
    // checkCountersignFailed for the full rationale: only "polite" (peers WE
    // joined) relationships count toward "every link failed."
    private checkCountersignFailed(): void {
      const polite = [...this.peers.values()].filter((p) => p.polite);
      if (polite.length > 0 && polite.every((p) => p.proof.phase === "failed")) {
        this.countersignFailedCount += 1;
      }
    }
  }

  /** Advances the fake clock in small async-aware steps until `predicate`
   *  holds, yielding to the microtask queue each step so a real in-flight
   *  crypto.subtle promise gets a chance to settle (see the describe header). */
  async function waitForFake(predicate: () => boolean, maxTicks = 200): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (predicate()) return;
      await vi.advanceTimersByTimeAsync(0);
    }
    throw new Error("waitForFake: condition not met within maxTicks");
  }

  it("honest pair: messages dropped and a stream withheld until proven; both surface once proven", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const a = new GatingHarness("peer-a", () => proofKey);
    const b = new GatingHarness("peer-b", () => proofKey);

    // A joins a room where B already exists (A polite toward B, matching
    // addExistingPeers); B sees A as a newcomer (impolite, addNewcomer) —
    // the same shape session.ts wires off the signaling events.
    a.mesh.addExistingPeers(["peer-b"], false);
    b.mesh.addNewcomer("peer-a", false);
    await vi.advanceTimersByTimeAsync(STAGGER_MS);
    a.wireTo("peer-b", b, "peer-a");
    b.wireTo("peer-a", a, "peer-b");

    expect(a.roster).toEqual([]); // invisible before any proof even starts

    a.openChannel("peer-b");
    b.openChannel("peer-a");

    // A stream arrives on B's side (from A) while the proof is still
    // pending, and A broadcasts too early — both must be silently withheld,
    // not queued for later delivery.
    const stream = {} as MediaStream;
    b.deliverStream("peer-a", stream);
    a.mesh.sendAll("too-early");
    expect(b.roster).toEqual([]); // still unproven — stream not surfaced, peer invisible
    expect(b.deliveredMessages).toEqual([]);

    await waitForFake(
      () => a.proofPhaseOf("peer-b") === "proven" && b.proofPhaseOf("peer-a") === "proven",
    );

    // Proven: the stashed stream is surfaced and the peer is now visible —
    // but the earlier broadcast is gone for good (dropped, never queued).
    expect(b.roster).toEqual([{ peerId: "peer-a", stream, connectionState: "new" }]);
    expect(a.roster).toEqual([{ peerId: "peer-b", stream: null, connectionState: "new" }]);
    expect(b.deliveredMessages).toEqual([]);

    a.mesh.sendAll("hello");
    expect(b.deliveredMessages).toEqual([["peer-a", "hello"]]);
  });

  it("wrong-secret peer: never surfaces, never counted — joiner reaches countersign-failed, host sees no status change (D18)", async () => {
    const { secret: secretHost } = createRoomKeys();
    const { secret: secretStranger } = createRoomKeys();
    const { proofKey: hostKey } = await deriveRoomKeys(secretHost);
    const { proofKey: strangerKey } = await deriveRoomKeys(secretStranger);

    const host = new GatingHarness("peer-host", () => hostKey);
    const stranger = new GatingHarness("peer-stranger", () => strangerKey);

    // The stranger joins the host's already-populated room: stranger is
    // polite toward host (addExistingPeers); host sees a newcomer, impolite
    // (addNewcomer) — this asymmetry is exactly what checkCountersignFailed
    // keys off (see its doc in session.ts).
    stranger.mesh.addExistingPeers(["peer-host"], false);
    host.mesh.addNewcomer("peer-stranger", false);
    await vi.advanceTimersByTimeAsync(STAGGER_MS);
    host.wireTo("peer-stranger", stranger, "peer-host");
    stranger.wireTo("peer-host", host, "peer-stranger");

    host.openChannel("peer-stranger");
    stranger.openChannel("peer-host");

    await waitForFake(
      () => host.proofPhaseOf("peer-stranger") === "failed" && stranger.proofPhaseOf("peer-host") === "failed",
    );

    expect(host.roster).toEqual([]); // never counted, on either side
    expect(stranger.roster).toEqual([]);
    expect(host.deliveredMessages).toEqual([]);
    expect(stranger.deliveredMessages).toEqual([]);
    expect(host.linkFor("peer-stranger").closeCalls).toBe(1); // "this side closes the link" on failure
    expect(stranger.linkFor("peer-host").closeCalls).toBe(1);

    expect(stranger.countersignFailedCount).toBe(1); // the wrong-secret joiner's own view
    expect(host.countersignFailedCount).toBe(0); // D18 — right-secret host: no status change
  });

  it("sendAll and sendTo skip an unproven peer but still reach an already-proven one", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const a = new GatingHarness("peer-a", () => proofKey);
    const b = new GatingHarness("peer-b", () => proofKey);

    a.mesh.addExistingPeers(["peer-b", "peer-c"], false);
    b.mesh.addNewcomer("peer-a", false);
    await vi.advanceTimersByTimeAsync(STAGGER_MS * 2);
    a.wireTo("peer-b", b, "peer-a");
    b.wireTo("peer-a", a, "peer-b");

    a.openChannel("peer-b");
    b.openChannel("peer-a");
    // peer-c's channel never opens — its proof never even starts, stays
    // pending forever, exactly like a link stuck mid-negotiation.
    await waitForFake(
      () => a.proofPhaseOf("peer-b") === "proven" && b.proofPhaseOf("peer-a") === "proven",
    );
    expect(a.proofPhaseOf("peer-c")).toBe("pending");
    expect(a.roster.map((p) => p.peerId)).toEqual(["peer-b"]); // peer-c invisible

    a.mesh.sendAll("broadcast");
    expect(a.linkFor("peer-b").sent).toContain("broadcast");
    expect(a.linkFor("peer-c").sent).not.toContain("broadcast"); // unproven — skipped

    expect(a.mesh.sendTo("peer-b", "direct")).toBe(true);
    expect(a.mesh.sendTo("peer-c", "direct")).toBe(false); // unproven — refused, not queued
  });

  it("a 4C rebuild of a proven peer re-runs the proof: gated during, flows again once re-proven", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const a = new GatingHarness("peer-a", () => proofKey);
    const b = new GatingHarness("peer-b", () => proofKey);

    a.mesh.addExistingPeers(["peer-b"], false);
    b.mesh.addNewcomer("peer-a", false);
    await vi.advanceTimersByTimeAsync(STAGGER_MS);
    a.wireTo("peer-b", b, "peer-a");
    b.wireTo("peer-a", a, "peer-b");

    a.openChannel("peer-b");
    b.openChannel("peer-a");
    await waitForFake(
      () => a.proofPhaseOf("peer-b") === "proven" && b.proofPhaseOf("peer-a") === "proven",
    );
    expect(a.roster.map((p) => p.peerId)).toEqual(["peer-b"]);

    // A's link to B fails; mesh's own 4C recovery takes over: restartIce
    // immediately, then (unrecovered) a full rebuild off-tick. B's side is
    // untouched — an asymmetric rebuild is spec-legal (mesh.ts rebuildLink's
    // doc) and B's still-proven JoinProof instance answers a fresh incoming
    // challenge regardless of its own terminal phase (joinProof.ts:
    // answerChallenge runs "regardless of our OWN phase").
    a.setConnectionState("peer-b", "failed");
    await vi.advanceTimersByTimeAsync(RESTART_RECOVERY_MS);
    await vi.advanceTimersByTimeAsync(STAGGER_MS);

    // A fresh link for the SAME peerId — a fresh rising edge, gating re-armed.
    expect(a.roster).toEqual([]);
    expect(a.proofPhaseOf("peer-b")).toBe("pending");

    // Re-hook the loopback onto A's brand-new FakeLink (a real cos channel
    // has no such seam — it's still the same wire; B's own wireTo call from
    // before still resolves peer-a's CURRENT handle just-in-time, so it
    // needs no re-wiring).
    a.wireTo("peer-b", b, "peer-a");

    a.mesh.sendAll("during-reproof");
    expect(b.deliveredMessages).toEqual([]); // still gated — the fresh proof hasn't started

    a.openChannel("peer-b"); // the fresh cos channel's own open: the new rising edge
    await waitForFake(() => a.proofPhaseOf("peer-b") === "proven");

    expect(a.roster.map((p) => p.peerId)).toEqual(["peer-b"]);
    a.mesh.sendAll("after-reproof");
    expect(b.deliveredMessages).toEqual([["peer-a", "after-reproof"]]);
  });

  it("disposing every proof cancels its armed timeout — no stray onFailed after the fact", async () => {
    const { secret } = createRoomKeys();
    const { proofKey } = await deriveRoomKeys(secret);
    const a = new GatingHarness("peer-a", () => proofKey);

    a.mesh.addExistingPeers(["peer-b"], false);
    await vi.advanceTimersByTimeAsync(STAGGER_MS);
    a.openChannel("peer-b"); // arms the 5s proof timeout; nobody ever answers it

    a.disposeAllProofs();

    // Advancing well past the proof's own timeout must not fire onFailed —
    // dispose is a hard stop (mirrors JoinProof.dispose's own contract,
    // already unit-tested above; this proves CallSession-style cleanup
    // actually reaches it).
    await vi.advanceTimersByTimeAsync(6_000);
    expect(a.proofPhaseOf("peer-b")).toBe("pending"); // never moved — the timer was cancelled, not fired
    expect(a.roster).toEqual([]);
  });
});
