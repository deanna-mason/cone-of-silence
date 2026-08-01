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
    await flush();
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
    it("parses well-formed challenge and response messages", () => {
      expect(parseProofMsg(JSON.stringify({ t: "prf/challenge", nonce: "abc" }))).toEqual({
        t: "prf/challenge",
        nonce: "abc",
      });
      expect(parseProofMsg(JSON.stringify({ t: "prf/response", nonce: "abc", mac: "def" }))).toEqual({
        t: "prf/response",
        nonce: "abc",
        mac: "def",
      });
    });

    it("rejects malformed input without throwing (5 cases)", () => {
      expect(parseProofMsg("{not json")).toBeNull();
      expect(parseProofMsg("null")).toBeNull();
      expect(parseProofMsg('"a string"')).toBeNull();
      expect(parseProofMsg(JSON.stringify({ t: "prf/unknown" }))).toBeNull();
      expect(parseProofMsg(JSON.stringify({ nonce: "abc" }))).toBeNull(); // no t at all
    });
  });
});
