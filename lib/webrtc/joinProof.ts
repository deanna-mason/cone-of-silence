// lib/webrtc/joinProof.ts
// Phase 5D (D16): mutual join-proof over the cos channel. Before either side
// trusts a peer, BOTH sides challenge each other with a random nonce and
// must answer the other's challenge with an HMAC (under the room's derived
// proofKey, lib/crypto/derive.ts) bound to the RESPONDER's own peerId. That
// responder-id binding is the whole defense: without it, a message that is
// merely bounced back at its own sender (or replayed from an earlier leg of
// the same exchange) would carry a real, validly-signed HMAC and pass —
// binding the responder id means a reflected/replayed mac was signed under
// the wrong identity and fails verification even though it's a genuine HMAC
// output over genuine wire bytes.
//
// Wire messages, t-prefix idiom — foreign `t` / unparseable JSON silently
// ignored, same convention as lib/podcast/takeProtocol.ts:
//   { t: "prf/challenge", nonce }       — 16 random bytes, base64url (22 chars)
//   { t: "prf/response",  nonce, mac }  — echoes the challenge nonce;
//     mac = base64url(HMAC(proofKey, len-prefixed(nonce) ‖ len-prefixed(responderPeerId) ‖ utf8("resp")))
// `nonce` is validated against the exact wire format (22-char base64url) on
// every inbound message, in BOTH directions — not just for freshness, but
// because an unvalidated nonce is itself an attack surface (see macInput's
// doc comment) and an unbounded one is a pre-auth amplification vector: this
// side echoes the peer's own nonce back inside a real crypto.subtle.sign
// call before either side is trusted.
//
// One instance per remote peer (mirrors every other per-peer protocol object
// in this codebase). `phase` reflects ONLY whether THIS side's own challenge
// was answered validly — answering the remote's challenge proves something
// about US to THEM, not the reverse, so it never affects our own phase.
// `proven` and `failed` are both terminal: once reached, nothing (a stale
// timer fire, a replayed response, a duplicate bad mac) can move the phase
// again.

import { base64url } from "../base64url";
import { TOKEN_RE } from "../roomLink";

const DEFAULT_TIMEOUT_MS = 5000;
const NONCE_BYTES = 16;
const RESPONSE_LABEL = "resp";
// Wire nonce format, shared with lib/roomLink.ts's room-secret token format:
// exactly 22-char base64url (16 raw bytes, no padding). Any inbound `nonce`
// that doesn't match this — wrong length, foreign charset, or (the pre-auth
// oracle concern) attacker-inflated to megabytes — is malformed, full stop.
const NONCE_RE = TOKEN_RE;

export type ProofPhase = "pending" | "proven" | "failed";

export interface ProofEvents {
  onSend(text: string): void;
  onProven(): void;
  onFailed(reason: "bad-mac" | "timeout"): void;
}

export type ProofMsg = { t: "prf/challenge"; nonce: string } | { t: "prf/response"; nonce: string; mac: string };

export interface JoinProofDeps {
  proofKey: CryptoKey;
  selfPeerId: string;
  remotePeerId: string;
  events: ProofEvents;
  /** Defaults to 5000ms. */
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

function randomNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/** Big-endian 4-byte length prefix for one field of a length-prefixed
 * concatenation. 2^32 bytes is far beyond anything this module ever
 * produces (nonce/peerId are both tiny), so this can never itself overflow
 * or wrap. */
function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

/** len(nonce) ‖ utf8(nonce) ‖ len(responderPeerId) ‖ utf8(responderPeerId) ‖
 * utf8("resp") — every variable-length field carries its own byte count, so
 * the concatenation has exactly one valid parse. That's the actual defense:
 * WITHOUT length prefixes, a bare `utf8(nonce) ‖ utf8(responderPeerId)`
 * concatenation is ambiguous — an attacker who controls both its own peerId
 * and the nonce it sends in a challenge can choose a split point that reads
 * back as a DIFFERENT, victim-accepted (nonce, peerId) pair (e.g. peerId =
 * W ‖ victimId, nonce = N ‖ W collapses to the same bytes as nonce = N,
 * peerId = W ‖ victimId). `nonce` is additionally fixed-length by
 * `parseProofMsg`'s NONCE_RE check, which independently closes this
 * specific shape of the attack — but this function does not get to assume
 * that invariant, or any invariant about peerId shape (that lives in
 * server/src/rooms/registry.ts today and could change under Task 5
 * wiring), which is why the length prefix is here regardless. This is NOT
 * about the "resp" suffix — a fixed trailing constant can never be
 * confused with a variable-length field that precedes it. */
function macInput(nonce: string, responderPeerId: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const nonceBytes = enc.encode(nonce);
  const idBytes = enc.encode(responderPeerId);
  const parts = [u32be(nonceBytes.length), nonceBytes, u32be(idBytes.length), idBytes, enc.encode(RESPONSE_LABEL)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function computeMac(proofKey: CryptoKey, nonce: string, responderPeerId: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", proofKey, macInput(nonce, responderPeerId));
  return base64url(new Uint8Array(sig));
}

/** Parses one wire message. Returns null for unparseable JSON, a non-object,
 * an unrecognized/foreign `t`, or a recognized `t` with a malformed field —
 * every rejection path is silent, never throws, mirroring takeProtocol's
 * parseWireMsg. `nonce` is checked against the exact wire format (NONCE_RE)
 * in both message shapes: this is pre-auth input from a not-yet-trusted
 * peer that this module will feed straight into a real HMAC computation
 * (see answerChallenge), so an oversized or foreign-charset nonce is
 * rejected here, before that ever happens, rather than merely failing to
 * verify afterward. */
export function parseProofMsg(text: string): ProofMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const t = (msg as { t?: unknown }).t;
  if (t === "prf/challenge") {
    const nonce = (msg as { nonce?: unknown }).nonce;
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
    return { t: "prf/challenge", nonce };
  }
  if (t === "prf/response") {
    const nonce = (msg as { nonce?: unknown }).nonce;
    const mac = (msg as { mac?: unknown }).mac;
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
    if (typeof mac !== "string") return null;
    return { t: "prf/response", nonce, mac };
  }
  return null;
}

export class JoinProof {
  private readonly proofKey: CryptoKey;
  private readonly selfPeerId: string;
  private readonly remotePeerId: string;
  private readonly events: ProofEvents;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private _phase: ProofPhase = "pending";
  private started = false;
  private disposed = false;
  // The nonce of OUR outstanding challenge — the only nonce a prf/response
  // can ever be verified against. Cleared the instant it's consumed (proven
  // or failed), so neither a stale timer nor a replayed response can act on
  // it again — this is what makes a stale nonce provably never verify.
  private ownChallengeNonce: string | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: JoinProofDeps) {
    // A self-challenge (own id used as both self and remote) makes
    // reflection succeed by definition — the mac this side computes when
    // answering its own challenge is, byte-for-byte, the mac its own
    // verifier expects, with no attacker involvement at all. This can never
    // be a legitimate wiring (Task 5 constructs one instance per REMOTE
    // peer), so refuse to construct rather than silently proving nothing.
    if (deps.selfPeerId === deps.remotePeerId) {
      throw new Error("JoinProof: selfPeerId and remotePeerId must differ");
    }
    this.proofKey = deps.proofKey;
    this.selfPeerId = deps.selfPeerId;
    this.remotePeerId = deps.remotePeerId;
    this.events = deps.events;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  }

  get phase(): ProofPhase {
    return this._phase;
  }

  /** Sends our own challenge and arms the timeout. Idempotent — a second
   * call (or a call after dispose) is a no-op, since re-issuing a challenge
   * would invalidate the nonce an in-flight honest response is answering. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const nonce = randomNonce();
    this.ownChallengeNonce = nonce;
    this.events.onSend(JSON.stringify({ t: "prf/challenge", nonce }));
    this.timeoutId = this.setTimeoutFn(() => {
      this.timeoutId = null;
      this.fail("timeout");
    }, this.timeoutMs);
  }

  /** Feeds one inbound wire message. Returns true iff it was a recognized
   * prf/* message (so a cos-channel consumer knows whether to route it
   * elsewhere) — true is returned for a stale/replayed response too, since
   * it was still a well-formed proof message, just one with no effect. */
  handleMessage(text: string): boolean {
    const msg = parseProofMsg(text);
    if (!msg) return false;
    if (this.disposed) return true; // consumed for routing; dispose silences every side effect
    if (msg.t === "prf/challenge") {
      void this.answerChallenge(msg.nonce);
    } else {
      void this.verifyResponse(msg.nonce, msg.mac);
    }
    return true;
  }

  /** Answers an incoming challenge — regardless of our OWN phase, because
   * the remote needs this to reach ITS proven state even after we've
   * already reached ours (both challenges must always get answered for the
   * handshake to complete on both sides, however the two legs interleave). */
  private async answerChallenge(nonce: string): Promise<void> {
    // Mac binds THIS side as responder — see the module doc's reflection
    // defense: this is the field an attacker cannot choose or copy from
    // elsewhere without it becoming a different, unverifiable mac.
    let mac: string;
    try {
      mac = await computeMac(this.proofKey, nonce, this.selfPeerId);
    } catch {
      // House idiom (lib/podcast/transfer.ts's fault()): every inner await
      // of a void-dispatched async method is caught and routed to a clean
      // failure, never left to become an unhandled rejection. A
      // subtle.sign rejection here (non-HMAC key, insecure context) means
      // this side can't prove anything to the remote either way.
      this.fail("bad-mac");
      return;
    }
    if (this.disposed) return;
    this.events.onSend(JSON.stringify({ t: "prf/response", nonce, mac }));
  }

  private async verifyResponse(nonce: string, mac: string): Promise<void> {
    if (this._phase !== "pending") return; // terminal — nothing left to prove or fail
    if (this.ownChallengeNonce === null || nonce !== this.ownChallengeNonce) return; // not an answer to OUR outstanding challenge: stale, foreign, or replayed — silently ignored (a real answer, if one is ever coming, still can; otherwise the timeout fails us)
    let expected: string;
    try {
      expected = await computeMac(this.proofKey, nonce, this.remotePeerId);
    } catch {
      this.fail("bad-mac"); // same house idiom as answerChallenge above
      return;
    }
    // Re-check after the await: two verifyResponse calls can be in flight
    // concurrently (e.g. a bad-mac reflection racing the real answer, or a
    // timeout firing mid-verification), and only whichever the state
    // machine settles on FIRST may act — this guard is what makes the
    // second one a no-op instead of a double-fire. The settle order between
    // a concurrent good and bad response is genuinely nondeterministic
    // (both are independent crypto.subtle.sign calls) but that's benign by
    // direction: a bad mac can never CREATE trust, it can only fail to veto
    // it, so whichever loses the race was never going to change the
    // outcome once the winner has already fired.
    if (this.disposed || this._phase !== "pending") return;
    // Constant-time-ish comparison: both operands are base64url encodings of
    // fixed-length (32-byte HMAC-SHA-256) outputs, never attacker-chosen in
    // length, so a plain `===` does not leak a variable-length signal — and
    // JS gives no API for a manual byte-loop compare that isn't itself just
    // as content-dependent under a real JIT. Do not "optimize" this into an
    // early-exit loop over secret-derived bytes.
    if (mac !== expected) {
      this.fail("bad-mac");
      return;
    }
    this.ownChallengeNonce = null; // consumed — this exact valid response can never be replayed to re-fire onProven
    this.clearTimer();
    this._phase = "proven";
    this.events.onProven();
  }

  private fail(reason: "bad-mac" | "timeout"): void {
    if (this._phase !== "pending" || this.disposed) return;
    this.ownChallengeNonce = null;
    this.clearTimer();
    this._phase = "failed";
    this.events.onFailed(reason);
  }

  private clearTimer(): void {
    if (this.timeoutId !== null) {
      this.clearTimeoutFn(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /** Cancels the armed timeout and hard-stops every future side effect: no
   * onSend/onProven/onFailed can fire again, even if handleMessage is still
   * called afterward (a well-formed prf/* message post-dispose is silently
   * swallowed, not acted on). */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}
