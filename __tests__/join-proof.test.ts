// @vitest-environment node
// Task 3 (Phase 5D): mutual join-proof state machine. Pure-crypto module, no
// DOM needed — same reasoning as crypto-frame.test.ts. Two real JoinProof
// instances are driven against each other over a hand-wired in-memory "bus"
// (the loopback-harness idiom from episode-exchange-loopback.test.ts, scaled
// down to this module's much simpler two-message protocol); keys come from
// the real deriveRoomKeys (Task 1), not mocks — this state machine is only as
// trustworthy as the HMACs it actually verifies.
import { describe, expect, it } from "vitest";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";
import { JoinProof, parseProofMsg, type ProofEvents, type ProofPhase } from "@/lib/webrtc/joinProof";

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
