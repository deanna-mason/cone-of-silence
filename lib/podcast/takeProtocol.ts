// Take coordinator: the roll/stop handshake between the two sides of a call,
// plus clock-offset estimation and beacon relay, all over the existing
// data-channel bus (hooks/useCallSession.ts). Cross-machine precision is
// non-critical here — the recorded tone (lib/podcast/toneMark.ts) is the
// real alignment authority; this class only has to get both recorders
// rolling before the mark lands, and keep the two sides talking about the
// same take. Every wire message is JSON with a "t" field prefixed "pod/" so
// other protocols can share the same channel later; anything else (foreign
// "t", or unparseable JSON) is silently ignored.
import type { CallBus } from "@/hooks/useCallSession";
import type { Beacon, FaultCause } from "./watchdog";
import { MARK_TOTAL_MS } from "./toneMark";

export const COUNTDOWN_MS = 3_500; // proposer lead: countdown + schedule slack
export const ROLL_LEAD_MS = 500; // recorders start this far BEFORE the mark
const STOP_LEAD_MS = 1_000; // stop mark lands this far after requestStop()
const PING_ROUNDS = 3; // best-of-3 RTT samples for the clock-offset estimate

/** The per-take headphones declaration. "speakers" = open speakers, the
 *  recording graph engages echo-guard (EC-on capture). Rides pod/hello as an
 *  additive field; the consumer re-announces on every change. */
export type Phones = "headphones" | "speakers";

export interface TakeCallbacks {
  onPartnerCodename(name: string): void;
  /** The partner's current headphones declaration — state, not an event;
   *  fires with every accepted hello (null = undeclared or pre-field peer). */
  onPartnerPhones(phones: Phones | null): void;
  onCountdown(msLeft: number): void; // 1 Hz during the countdown
  onStartRecorders(takeId: string): void; // fire recorders NOW (T-500 ms)
  onMark(): void; // schedule the tone NOW (T)
  onStopMark(): void; // end-of-take tone NOW
  onStopRecorders(takeId: string): void; // after end mark completes
  onAborted(takeId: string): void; // stop arrived before start ever fired — nothing to keep
  onBeacon(b: Beacon): void; // partner's 1 Hz state
}

// Partner pinning rule:
//   - pod/hello: latest hello WINS while no take/proposal is active (re-pin +
//     codename update — heals a partner swap). While a take or unacked
//     proposal is active the partner is PINNED and a hello from any other
//     peerId is IGNORED — but stashed as pendingHello (latest wins), applied
//     the instant the take ends (abortTake / scheduleStop's completion
//     timer). This is the ledgered third-host codename-clobber rider AND the
//     drill's rejoin heal: a partner who force-quit and relaunched under a
//     new peerId mid-take is re-pinned the moment Cut lands, not stuck
//     forever pinned to a ghost.
//   - pod/roll: a peerId that doesn't match an already-pinned partner is
//     dropped (roll can only come from a host who heard our hello); with no
//     partner pinned yet, the roll itself pins the proposer. propose() will
//     not send with no partner pinned either — it returns null, same as an
//     already-active slot.
//   - ping/pong/roll-ack/stop/beacon from a peerId !== partnerId are dropped.
//   - Sends: hello stays sendAll (discovery); EVERYTHING else goes
//     bus.sendTo(partnerId, ...) — with four seats, beacons and roll traffic
//     must never spray the whole room.
//   - canAcceptRoll() === false → an inbound pod/roll is ignored entirely (no
//     ack, no slot claim); the proposer's own abort-if-unacked (5A FIX-2)
//     unwinds their countdown.
export interface TakeProtocolDeps {
  /** Defaults to Date.now; injectable so tests can simulate a skewed clock. */
  now?: () => number;
  /** Gates acceptance of an inbound pod/roll — default () => true. The hook
   *  wires this to "no transfer in flight AND headphones declared": a false
   *  return is a deliberate quiet ignore (no ack, no slot claim, no fault);
   *  the proposer's own abort-if-unacked (5A FIX-2) unwinds their countdown. */
  canAcceptRoll?: () => boolean;
  /** This side's current headphones declaration, read at every hello send —
   *  default () => null (field omitted from the wire). */
  localPhones?: () => Phones | null;
}

type HelloMsg = { t: "pod/hello"; codename: string; phones?: Phones };
type PingMsg = { t: "pod/ping"; sentAt: number };
type PongMsg = { t: "pod/pong"; sentAt: number };
type RollMsg = { t: "pod/roll"; takeId: string; startAtMs: number };
type RollAckMsg = { t: "pod/roll-ack"; takeId: string };
type StopMsg = { t: "pod/stop"; takeId: string; markAtMs: number };
type BeaconMsg = { t: "pod/beacon" } & Beacon;

type WireMsg = HelloMsg | PingMsg | PongMsg | RollMsg | RollAckMsg | StopMsg | BeaconMsg;

// Every literal of watchdog.ts's FaultCause union, kept here (not derived
// mechanically — TS has no runtime reflection over a type) so parseWireMsg
// can enforce enum MEMBERSHIP, not just typeof === "string". A member-lint
// mismatch here would be caught by TS: FAULT_CAUSES is typed
// `ReadonlySet<FaultCause>`, so a typo'd or stale literal fails to compile.
const FAULT_CAUSES: ReadonlySet<FaultCause> = new Set<FaultCause>([
  "camera-lost",
  "mic-lost",
  "encoder-stalled",
  "disk-error",
  "encoder-error",
  "echo-guard",
  "partner-fault",
  "partner-silent",
]);

/** Mirrors lib/podcast/transfer.ts's isValidOffer's enum-membership style
 *  (`rec.base === "audio" || rec.base === "video"`) — a string that ISN'T
 *  one of these literals must be rejected, not merely any string. An
 *  unvalidated `fault` would reach components/PodcastPanel.tsx's
 *  `CAUSE_COPY[fault]` lookup and render "PARTNER: undefined" for any cause
 *  a malformed or adversarial peer named. */
function isFaultCause(x: unknown): x is FaultCause {
  return typeof x === "string" && FAULT_CAUSES.has(x as FaultCause);
}

/** Parses one wire message. Returns null for unparseable JSON, a non-object,
 *  an unrecognized/foreign `t`, or a recognized `t` with a malformed field —
 *  every rejection path is silent, never throws, mirroring
 *  lib/webrtc/joinProof.ts's parseProofMsg. Field guards per message type
 *  (mirroring lib/podcast/transfer.ts's isValidOffer/isValidPartFrame) are
 *  load-bearing beyond mere type safety: a non-number startAtMs/markAtMs
 *  reaching scheduleRoll()/scheduleStop() untouched produces a NaN delay,
 *  and setTimeout clamps a NaN delay to 0 per spec — so a malformed pod/roll
 *  wouldn't just be ignored, it would fire the take almost immediately
 *  instead of respecting the countdown. Number.isFinite (not just
 *  typeof === "number") excludes NaN/Infinity themselves from ever reaching
 *  that arithmetic in the first place. */
function parseWireMsg(text: string): WireMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const t = m.t;
  if (typeof t !== "string" || !t.startsWith("pod/")) return null;

  switch (t) {
    case "pod/hello": {
      if (typeof m.codename !== "string") return null;
      // `phones` is additive and OPTIONAL (absent = pre-field peer or
      // undeclared) — but present-and-invalid rejects the whole message,
      // same enum-membership stance as `fault` below.
      if (m.phones !== undefined && m.phones !== "headphones" && m.phones !== "speakers") return null;
      return { t: "pod/hello", codename: m.codename, ...(m.phones !== undefined ? { phones: m.phones } : {}) };
    }
    case "pod/ping": {
      if (typeof m.sentAt !== "number" || !Number.isFinite(m.sentAt)) return null;
      return { t: "pod/ping", sentAt: m.sentAt };
    }
    case "pod/pong": {
      if (typeof m.sentAt !== "number" || !Number.isFinite(m.sentAt)) return null;
      return { t: "pod/pong", sentAt: m.sentAt };
    }
    case "pod/roll": {
      if (typeof m.takeId !== "string") return null;
      if (typeof m.startAtMs !== "number" || !Number.isFinite(m.startAtMs)) return null;
      return { t: "pod/roll", takeId: m.takeId, startAtMs: m.startAtMs };
    }
    case "pod/roll-ack": {
      if (typeof m.takeId !== "string") return null;
      return { t: "pod/roll-ack", takeId: m.takeId };
    }
    case "pod/stop": {
      if (typeof m.takeId !== "string") return null;
      if (typeof m.markAtMs !== "number" || !Number.isFinite(m.markAtMs)) return null;
      return { t: "pod/stop", takeId: m.takeId, markAtMs: m.markAtMs };
    }
    case "pod/beacon": {
      if (typeof m.rolling !== "boolean") return null;
      if (typeof m.bytes !== "number" || !Number.isFinite(m.bytes)) return null;
      if (typeof m.camOk !== "boolean") return null;
      if (typeof m.micOk !== "boolean") return null;
      const fault = m.fault;
      if (fault !== null && !isFaultCause(fault)) return null;
      return {
        t: "pod/beacon",
        rolling: m.rolling,
        bytes: m.bytes,
        camOk: m.camOk,
        micOk: m.micOk,
        fault,
      };
    }
    default:
      return null;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function randomHex4(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function takeIdFor(atMs: number): string {
  const d = new Date(atMs);
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  return `take-${stamp}-${randomHex4()}`;
}

/**
 * Roll/stop handshake, clock-offset estimation, and beacon relay over a
 * CallBus. One take may be in flight at a time; a second `pod/roll` while
 * one is active is ignored. `dispose()` unsubscribes from the bus and
 * cancels every pending timer — no callback fires after that.
 */
export class TakeCoordinator {
  private readonly bus: CallBus;
  private readonly codename: string;
  private readonly cb: TakeCallbacks;
  private readonly nowFn: () => number;
  private readonly canAcceptRollFn: () => boolean;
  private readonly localPhonesFn: () => Phones | null;
  private readonly unsubscribe: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  // The pinned partner's peerId — see the pinning-rule comment above
  // TakeProtocolDeps. null until the first hello or roll is heard.
  private partnerId: string | null = null;
  // A hello ignored by onHello's mid-take pin (a foreign peerId while
  // activeTakeId !== null) — latest one wins. Applied by applyPendingHello()
  // the instant the take ends, healing a partner who rejoined under a new
  // peerId mid-take instead of leaving partnerId pinned to a ghost forever.
  private pendingHello: { peerId: string; codename: string; phones: Phones | null } | null = null;

  // Hello handshake.
  private helloSent = false;
  private helloReceived = false;

  // Clock offset (this side's clock minus the partner's), estimated via
  // best-of-3 ping/pong RTT sampling, kicked off once hello completes both
  // ways. Defaults to 0 until at least one sample lands.
  private pingsSent = 0;
  private pendingPingSentAt: number | null = null;
  private myRtts: number[] = [];
  private peerGuesses: number[] = [];
  private offsetMs = 0;

  // Take state. `startFired` tracks whether THIS side's onStartRecorders has
  // fired for the active take — it gates whether a stop aborts the take
  // (nothing recorded yet, safe to cancel) or runs the normal stop path.
  // `rollTimers` is the subset of `timers` scheduled by scheduleRoll(), so a
  // stop-before-start can cancel just the roll-phase timers (countdown
  // ticks, start, mark) without touching anything else.
  private activeTakeId: string | null = null;
  private pendingProposal: { takeId: string; startAtMs: number } | null = null;
  private startFired = false;
  private rollTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(bus: CallBus, codename: string, cb: TakeCallbacks, deps: TakeProtocolDeps = {}) {
    this.bus = bus;
    this.codename = codename;
    this.cb = cb;
    this.nowFn = deps.now ?? Date.now;
    this.canAcceptRollFn = deps.canAcceptRoll ?? (() => true);
    this.localPhonesFn = deps.localPhones ?? (() => null);
    this.unsubscribe = bus.onMessage((peerId, text) => this.onMessage(peerId, text));
  }

  private now(): number {
    return this.nowFn();
  }

  private send(msg: WireMsg): void {
    this.bus.sendAll(JSON.stringify(msg));
  }

  /** Targeted counterpart to send() — every non-hello message goes only to
   *  the pinned partner, never the whole room (see the pinning-rule comment
   *  above TakeProtocolDeps). A no-op while no partner is pinned yet — there
   *  is nothing to target. */
  private sendToPartner(msg: WireMsg): void {
    if (this.partnerId === null) return;
    this.bus.sendTo(this.partnerId, JSON.stringify(msg));
  }

  private schedule(delayMs: number, fn: () => void, bucket?: Set<ReturnType<typeof setTimeout>>): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      bucket?.delete(id);
      if (this.disposed) return;
      fn();
    }, Math.max(0, delayMs));
    this.timers.add(id);
    bucket?.add(id);
  }

  /** Cancels only the roll-phase timers (countdown ticks, start, mark) — used by a stop-before-start abort. */
  private cancelRollTimers(): void {
    for (const id of this.rollTimers) {
      clearTimeout(id);
      this.timers.delete(id);
    }
    this.rollTimers.clear();
  }

  /** Converts a timestamp from the partner's clock into this side's clock. */
  private toLocal(remoteMs: number): number {
    return remoteMs + this.offsetMs;
  }

  private sendHello(): void {
    this.helloSent = true;
    const phones = this.localPhonesFn();
    this.send({ t: "pod/hello", codename: this.codename, ...(phones !== null ? { phones } : {}) });
  }

  /** The auto-reply to an incoming hello — latched, so a hello can never
   *  bounce back and forth. announce() is the un-latched counterpart. */
  private ensureHelloSent(): void {
    if (this.helloSent) return;
    this.sendHello();
  }

  private maybeStartPinging(): void {
    if (this.pingsSent > 0 || !this.helloSent || !this.helloReceived) return;
    this.sendPing();
  }

  private sendPing(): void {
    if (this.pingsSent >= PING_ROUNDS) return;
    this.pingsSent += 1;
    const sentAt = this.now();
    this.pendingPingSentAt = sentAt;
    this.sendToPartner({ t: "pod/ping", sentAt });
  }

  /**
   * offset = this side's clock − the peer's, applied by toLocal() to convert
   * a remote timestamp into this side's clock. `myRtts` and `peerGuesses`
   * are two independent streams (my outgoing ping/pong round trips vs. the
   * peer's incoming pings) with no shared round id to pair them by, so
   * "best of 3" is applied to each independently rather than picking a
   * single matched round: the MIN of my own RTTs is the best available
   * estimate of pure one-way transit delay (anything above the floor is
   * queuing jitter to discard), while the LATEST peer guess keeps the
   * estimate current against clock drift since the last sample.
   */
  private updateOffsetEstimate(): void {
    if (this.myRtts.length === 0 || this.peerGuesses.length === 0) return;
    const bestRtt = Math.min(...this.myRtts);
    const latestGuess = this.peerGuesses[this.peerGuesses.length - 1]!;
    this.offsetMs = latestGuess - bestRtt / 2;
  }

  private onMessage(peerId: string, text: string): void {
    const msg = parseWireMsg(text);
    if (!msg) return;
    switch (msg.t) {
      case "pod/hello":
        this.onHello(peerId, msg);
        break;
      case "pod/ping":
        if (peerId !== this.partnerId) return; // not our pinned partner — drop
        // Receiver's own receive time vs. the ping's embedded send time:
        // this is the partner's clock offset plus one-way transit delay.
        // The RTT/2 correction (once our own ping round trip is known)
        // happens in updateOffsetEstimate().
        this.peerGuesses.push(this.now() - msg.sentAt);
        this.updateOffsetEstimate();
        this.sendToPartner({ t: "pod/pong", sentAt: msg.sentAt });
        break;
      case "pod/pong":
        if (peerId !== this.partnerId) return; // not our pinned partner — drop
        if (this.pendingPingSentAt !== null) {
          this.myRtts.push(this.now() - this.pendingPingSentAt);
          this.pendingPingSentAt = null;
          this.updateOffsetEstimate();
        }
        this.sendPing();
        break;
      case "pod/roll":
        this.onRollReceived(peerId, msg);
        break;
      case "pod/roll-ack":
        if (peerId !== this.partnerId) return; // not our pinned partner — drop
        this.onRollAck(msg);
        break;
      case "pod/stop":
        if (peerId !== this.partnerId) return; // not our pinned partner — drop
        this.onStop(msg);
        break;
      case "pod/beacon": {
        if (peerId !== this.partnerId) return; // not our pinned partner — drop
        const { rolling, bytes, camOk, micOk, fault } = msg;
        this.cb.onBeacon({ rolling, bytes, camOk, micOk, fault });
        break;
      }
    }
  }

  /**
   * pod/hello pinning (see the pinning-rule comment above TakeProtocolDeps):
   * latest hello wins while idle (re-pin + codename update, heals a partner
   * swap); while a take or unacked proposal is active (`activeTakeId !==
   * null` — propose() and onRoll() both claim it synchronously) the partner
   * is PINNED and a hello from any other peerId is ignored. This is the
   * ledgered third-host codename-clobber rider.
   */
  private onHello(peerId: string, msg: HelloMsg): void {
    if (this.partnerId !== null && peerId !== this.partnerId && this.activeTakeId !== null) {
      // Pinned mid-take/proposal — a foreign hello cannot clobber
      // partnerCodename, but it isn't discarded either: stash it (latest
      // wins) so applyPendingHello() can heal the moment the take ends.
      this.pendingHello = { peerId, codename: msg.codename, phones: msg.phones ?? null };
      return;
    }
    this.partnerId = peerId;
    this.pendingHello = null; // a live re-announce supersedes any earlier stashed hello — latest wins for real
    this.helloReceived = true;
    this.cb.onPartnerCodename(msg.codename);
    this.cb.onPartnerPhones(msg.phones ?? null);
    this.ensureHelloSent();
    this.maybeStartPinging();
  }

  /**
   * Applies a hello stashed by onHello's mid-take ignore branch, once the
   * take actually ends — called from the tail of abortTake() and from
   * scheduleStop()'s completion timer, the two places activeTakeId returns
   * to null. A no-op when nothing was stashed. This is the drill's rejoin
   * heal: a partner who force-quit and relaunched under a new peerId
   * mid-take is re-pinned here instead of leaving partnerId aimed at a ghost
   * forever.
   */
  private applyPendingHello(): void {
    if (!this.pendingHello) return;
    const { peerId, codename, phones } = this.pendingHello;
    this.pendingHello = null;
    this.partnerId = peerId;
    this.helloReceived = true;
    this.cb.onPartnerCodename(codename);
    this.cb.onPartnerPhones(phones);
    this.ensureHelloSent();
    this.maybeStartPinging();
  }

  /**
   * pod/roll pinning: a peerId that doesn't match an already-pinned partner
   * is dropped outright (roll can only come from the host who heard our
   * hello). canAcceptRoll() === false is checked next — a deliberate quiet
   * ignore (no ack, no slot claim, no fault); the proposer's own
   * abort-if-unacked (5A FIX-2, in propose()) unwinds their countdown. Only
   * then, with no partner pinned yet, does the roll itself pin the proposer.
   * The mutation-pinned onRoll() below (mutual-propose tie-break,
   * claimTakeSlot) is untouched past this gate.
   */
  private onRollReceived(peerId: string, msg: RollMsg): void {
    if (this.partnerId !== null && peerId !== this.partnerId) return; // not our pinned partner
    if (!this.canAcceptRollFn()) return; // e.g. a transfer in flight — quiet ignore
    if (this.partnerId === null) this.partnerId = peerId; // roll pins the proposer
    this.onRoll(msg);
  }

  /**
   * The one place a take slot is claimed — invariant: claiming a slot
   * always resets `startFired`. propose() and onRoll() both claim a slot
   * (a fresh takeId becomes `activeTakeId`) synchronously, before any wire
   * round trip completes; if `startFired` were left stale from a
   * just-finished previous take, a requestStop() landing in that pre-ack
   * window would read the OLD take's "already started" state and run the
   * normal stop path (onStopMark/onStopRecorders) for a take whose
   * recorders never actually started.
   */
  private claimTakeSlot(takeId: string): void {
    this.activeTakeId = takeId;
    this.startFired = false;
  }

  private scheduleRoll(takeId: string, startLocalMs: number): void {
    const scheduledAt = this.now();
    let ticksLeft = Math.floor((startLocalMs - scheduledAt) / 1000);
    while (ticksLeft > 0) {
      const msLeft = ticksLeft * 1000;
      this.schedule(startLocalMs - msLeft - scheduledAt, () => this.cb.onCountdown(msLeft), this.rollTimers);
      ticksLeft -= 1;
    }
    this.schedule(
      startLocalMs - ROLL_LEAD_MS - scheduledAt,
      () => {
        this.startFired = true;
        this.cb.onStartRecorders(takeId);
      },
      this.rollTimers,
    );
    this.schedule(startLocalMs - scheduledAt, () => this.cb.onMark(), this.rollTimers);
  }

  private onRoll(msg: RollMsg): void {
    if (this.activeTakeId !== null) {
      // Simultaneous mutual propose(): both sides set activeTakeId to their
      // OWN takeId synchronously, before either pod/roll crosses the wire,
      // so the plain guard above would otherwise drop both proposals
      // forever (neither side ever acks the other — permanent deadlock).
      // Break the tie the same way on both sides: only concede while our
      // own proposal is still unacked, and only to a rival takeId that
      // sorts first. Exactly one side concedes; the other's ack arrives
      // normally once the peer replies.
      if (!this.pendingProposal || msg.takeId >= this.pendingProposal.takeId) return;
      this.pendingProposal = null;
    }
    this.claimTakeSlot(msg.takeId);
    this.sendToPartner({ t: "pod/roll-ack", takeId: msg.takeId });
    this.scheduleRoll(msg.takeId, this.toLocal(msg.startAtMs));
  }

  private onRollAck(msg: RollAckMsg): void {
    if (!this.pendingProposal || this.pendingProposal.takeId !== msg.takeId) return;
    const { takeId, startAtMs } = this.pendingProposal;
    this.pendingProposal = null;
    this.scheduleRoll(takeId, startAtMs); // proposer's own clock — no conversion
  }

  private scheduleStop(takeId: string, markLocalMs: number): void {
    const scheduledAt = this.now();
    this.schedule(markLocalMs - scheduledAt, () => this.cb.onStopMark());
    this.schedule(markLocalMs + MARK_TOTAL_MS + 250 - scheduledAt, () => {
      this.activeTakeId = null;
      this.cb.onStopRecorders(takeId);
      this.applyPendingHello();
    });
  }

  /**
   * Stop-before-start: cancels the still-pending roll-phase timers so a
   * stale onStartRecorders/onMark can never fire, frees the take slot, and
   * fires onAborted once instead of the normal stop path. This is decided
   * independently by each side against its OWN startFired flag — clock
   * skew means one side can already be past its local start instant while
   * the other isn't, so one side may abort while the other runs the normal
   * stop path for the very same take. That asymmetry is accepted: a take
   * stopped within its first second (ROLL_LEAD_MS) was never a keepable
   * take, and the consumer tears the UI down on either path regardless.
   */
  private abortTake(takeId: string): void {
    this.cancelRollTimers();
    this.activeTakeId = null;
    this.pendingProposal = null;
    this.startFired = false;
    this.cb.onAborted(takeId);
    this.applyPendingHello();
  }

  private onStop(msg: StopMsg): void {
    if (msg.takeId !== this.activeTakeId) return;
    if (!this.startFired) {
      this.abortTake(msg.takeId);
      return;
    }
    this.scheduleStop(msg.takeId, this.toLocal(msg.markAtMs));
  }

  /**
   * Announce this side's codename; replies automatically on receipt too.
   *
   * NOT latched, deliberately: the bus underneath is `mesh.sendAll`, a
   * best-effort broadcast that SKIPS a closed or absent link rather than
   * queueing for it. An announcement made before the data channel opens is
   * therefore dropped on the floor, and a once-only hello would leave both
   * sides permanently nameless (and, because the ping/pong round only starts
   * once a hello has been *received*, permanently unsynchronised). The
   * consumer re-announces on every channel open and on roster changes.
   *
   * Repeats are safe: the partner's auto-reply is latched, so a re-announce
   * cannot start a reply storm, and `maybeStartPinging` is a no-op once the
   * first ping round has begun — a mid-take re-announce never disturbs an
   * offset estimate that is already in hand.
   */
  announce(): void {
    this.sendHello();
    this.maybeStartPinging();
  }

  /** Original spelling of announce(); kept for callers that read better this way. */
  hello(): void {
    this.announce();
  }

  /**
   * ROLL TAPE — proposes a new take. Returns the new takeId, or null when a
   * take already holds the slot (including one still draining its stop): no
   * message is sent in that case, and the caller must NOT enter a countdown
   * for a take that was never proposed.
   *
   * The proposal is fire-and-forget over a best-effort bus that drops rather
   * than queues on a closed channel, so an unanswerable proposal is possible
   * (a Phase-4C channel rebuild, a partner who left mid-handshake). Left
   * alone it wedges: scheduleRoll only runs on the ack, so the take would sit
   * in a countdown that never starts and never ends. A proposal still unacked
   * at its own startAtMs is therefore treated as an abort — the same clean
   * teardown a stop-before-start gets, which frees the slot and lets the
   * consumer re-arm.
   */
  propose(): string | null {
    if (this.activeTakeId !== null) return null;
    if (this.partnerId === null) return null; // nobody pinned yet — avoids a phantom countdown (Task 9 fix #2)
    const startAtMs = this.now() + COUNTDOWN_MS;
    const takeId = takeIdFor(this.now());
    this.claimTakeSlot(takeId);
    this.pendingProposal = { takeId, startAtMs };
    this.sendToPartner({ t: "pod/roll", takeId, startAtMs });
    this.schedule(
      startAtMs - this.now(),
      () => {
        // Still OUR unacked proposal? An ack, or conceding a tie-break, clears
        // pendingProposal and makes this a no-op.
        if (this.pendingProposal?.takeId !== takeId) return;
        this.abortTake(takeId);
      },
      this.rollTimers,
    );
    return takeId;
  }

  /** Either side may call this to end the active take. No-op if none is active. */
  requestStop(): void {
    if (this.activeTakeId === null) return;
    const takeId = this.activeTakeId;
    const markAtMs = this.now() + STOP_LEAD_MS;
    // Always send, even mid-countdown — the partner needs to abort/stop too.
    this.sendToPartner({ t: "pod/stop", takeId, markAtMs });
    if (!this.startFired) {
      this.abortTake(takeId);
      return;
    }
    this.scheduleStop(takeId, markAtMs); // own clock — no conversion
  }

  sendBeacon(b: Beacon): void {
    this.sendToPartner({ t: "pod/beacon", ...b });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
}
