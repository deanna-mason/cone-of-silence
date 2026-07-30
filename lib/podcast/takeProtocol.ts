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
import type { Beacon } from "./watchdog";
import { MARK_TOTAL_MS } from "./toneMark";

export const COUNTDOWN_MS = 3_500; // proposer lead: countdown + schedule slack
export const ROLL_LEAD_MS = 500; // recorders start this far BEFORE the mark
const STOP_LEAD_MS = 1_000; // stop mark lands this far after requestStop()
const PING_ROUNDS = 3; // best-of-3 RTT samples for the clock-offset estimate

export interface TakeCallbacks {
  onPartnerCodename(name: string): void;
  onCountdown(msLeft: number): void; // 1 Hz during the countdown
  onStartRecorders(takeId: string): void; // fire recorders NOW (T-500 ms)
  onMark(): void; // schedule the tone NOW (T)
  onStopMark(): void; // end-of-take tone NOW
  onStopRecorders(takeId: string): void; // after end mark completes
  onBeacon(b: Beacon): void; // partner's 1 Hz state
}

export interface TakeProtocolDeps {
  /** Defaults to Date.now; injectable so tests can simulate a skewed clock. */
  now?: () => number;
}

type HelloMsg = { t: "pod/hello"; codename: string };
type PingMsg = { t: "pod/ping"; sentAt: number };
type PongMsg = { t: "pod/pong"; sentAt: number };
type RollMsg = { t: "pod/roll"; takeId: string; startAtMs: number };
type RollAckMsg = { t: "pod/roll-ack"; takeId: string };
type StopMsg = { t: "pod/stop"; takeId: string; markAtMs: number };
type BeaconMsg = { t: "pod/beacon" } & Beacon;

type WireMsg = HelloMsg | PingMsg | PongMsg | RollMsg | RollAckMsg | StopMsg | BeaconMsg;

function parseWireMsg(text: string): WireMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const t = (msg as { t?: unknown }).t;
  if (typeof t !== "string" || !t.startsWith("pod/")) return null;
  return msg as WireMsg;
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
  private readonly unsubscribe: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

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

  // Take state.
  private activeTakeId: string | null = null;
  private pendingProposal: { takeId: string; startAtMs: number } | null = null;

  constructor(bus: CallBus, codename: string, cb: TakeCallbacks, deps: TakeProtocolDeps = {}) {
    this.bus = bus;
    this.codename = codename;
    this.cb = cb;
    this.nowFn = deps.now ?? Date.now;
    this.unsubscribe = bus.onMessage((_peerId, text) => this.onMessage(text));
  }

  private now(): number {
    return this.nowFn();
  }

  private send(msg: WireMsg): void {
    this.bus.sendAll(JSON.stringify(msg));
  }

  private schedule(delayMs: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.disposed) return;
      fn();
    }, Math.max(0, delayMs));
    this.timers.add(id);
  }

  /** Converts a timestamp from the partner's clock into this side's clock. */
  private toLocal(remoteMs: number): number {
    return remoteMs + this.offsetMs;
  }

  private ensureHelloSent(): void {
    if (this.helloSent) return;
    this.helloSent = true;
    this.send({ t: "pod/hello", codename: this.codename });
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
    this.send({ t: "pod/ping", sentAt });
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

  private onMessage(text: string): void {
    const msg = parseWireMsg(text);
    if (!msg) return;
    switch (msg.t) {
      case "pod/hello":
        this.helloReceived = true;
        this.cb.onPartnerCodename(msg.codename);
        this.ensureHelloSent();
        this.maybeStartPinging();
        break;
      case "pod/ping":
        // Receiver's own receive time vs. the ping's embedded send time:
        // this is the partner's clock offset plus one-way transit delay.
        // The RTT/2 correction (once our own ping round trip is known)
        // happens in updateOffsetEstimate().
        this.peerGuesses.push(this.now() - msg.sentAt);
        this.updateOffsetEstimate();
        this.send({ t: "pod/pong", sentAt: msg.sentAt });
        break;
      case "pod/pong":
        if (this.pendingPingSentAt !== null) {
          this.myRtts.push(this.now() - this.pendingPingSentAt);
          this.pendingPingSentAt = null;
          this.updateOffsetEstimate();
        }
        this.sendPing();
        break;
      case "pod/roll":
        this.onRoll(msg);
        break;
      case "pod/roll-ack":
        this.onRollAck(msg);
        break;
      case "pod/stop":
        this.onStop(msg);
        break;
      case "pod/beacon": {
        const { rolling, bytes, camOk, micOk, fault } = msg;
        this.cb.onBeacon({ rolling, bytes, camOk, micOk, fault });
        break;
      }
    }
  }

  private scheduleRoll(takeId: string, startLocalMs: number): void {
    const scheduledAt = this.now();
    let ticksLeft = Math.floor((startLocalMs - scheduledAt) / 1000);
    while (ticksLeft > 0) {
      const msLeft = ticksLeft * 1000;
      this.schedule(startLocalMs - msLeft - scheduledAt, () => this.cb.onCountdown(msLeft));
      ticksLeft -= 1;
    }
    this.schedule(startLocalMs - ROLL_LEAD_MS - scheduledAt, () => this.cb.onStartRecorders(takeId));
    this.schedule(startLocalMs - scheduledAt, () => this.cb.onMark());
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
    this.activeTakeId = msg.takeId;
    this.send({ t: "pod/roll-ack", takeId: msg.takeId });
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
    });
  }

  private onStop(msg: StopMsg): void {
    if (msg.takeId !== this.activeTakeId) return;
    this.scheduleStop(msg.takeId, this.toLocal(msg.markAtMs));
  }

  /** Announce this side's codename; replies automatically on receipt too. */
  hello(): void {
    this.ensureHelloSent();
    this.maybeStartPinging();
  }

  /** ROLL TAPE — proposes a new take. No-op (returns the current id) if one's already active. */
  propose(): string {
    if (this.activeTakeId !== null) return this.activeTakeId;
    const startAtMs = this.now() + COUNTDOWN_MS;
    const takeId = takeIdFor(this.now());
    this.activeTakeId = takeId;
    this.pendingProposal = { takeId, startAtMs };
    this.send({ t: "pod/roll", takeId, startAtMs });
    return takeId;
  }

  /** Either side may call this to end the active take. No-op if none is active. */
  requestStop(): void {
    if (this.activeTakeId === null) return;
    const takeId = this.activeTakeId;
    const markAtMs = this.now() + STOP_LEAD_MS;
    this.send({ t: "pod/stop", takeId, markAtMs });
    this.scheduleStop(takeId, markAtMs); // own clock — no conversion
  }

  sendBeacon(b: Beacon): void {
    this.send({ t: "pod/beacon", ...b });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
}
