// Phase 5B Task 11: hooks/useEpisodeExchange.ts — the React glue over the
// shipped episode-exchange engines (lib/podcast/transfer.ts) and the xfer
// port (hooks/useCallSession.ts). episodeStore is vi.mock'd (per the task
// brief) with a small in-memory backing store so the HOOK's own engine
// (whichever role it plays in a given test) reads/writes fixture data
// instead of real disk. The "far peer" in each test is a REAL engine
// (EpisodeSender or EpisodeReceiver) wired through a hand-rolled fake
// XferPort — same shape as the Task 8 loopback test, adapted so the hook's
// own subscriptions (registered via renderHook) are the thing under test.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  mergePanel,
  useEpisodeExchange,
  type EpisodeExchange,
  type EpisodeExchangeArgs,
  type ExchangePanelState,
} from "@/hooks/useEpisodeExchange";
import type { PodcastPanelState } from "@/components/PodcastPanel";
import type { XferPort } from "@/hooks/useCallSession";
import type { ChannelLifecycle, ChannelName } from "@/lib/webrtc/session";
import { EpisodeReceiver, EpisodeSender, type SenderStore, type ReceiverStore, type XferLink } from "@/lib/podcast/transfer";
import { HashMismatchError } from "@/lib/podcast/episodeStore";
import type { IncomingPart, PartReader } from "@/lib/podcast/episodeStore";
import type { SidecarEntry } from "@/lib/podcast/vault";
import type { FilePlan } from "@/lib/podcast/xferProtocol";
import { createRoomKeys } from "@/lib/roomLink";
import { deriveRoomKeys } from "@/lib/crypto/derive";

// Task 6 (5D): useEpisodeExchange threads xferKey into the engines it
// constructs (mandatory dep, no keyless mode) — both this hook's own engine
// and every "far peer" real engine below share this one key, exactly as the
// session's single derived xferKey would in production.
let TEST_XFER_KEY: CryptoKey;
beforeAll(async () => {
  const { secret } = createRoomKeys();
  ({ xferKey: TEST_XFER_KEY } = await deriveRoomKeys(secret));
});

// ---------------------------------------------------------------------------
// vi.mock episodeStore — hoisted, in-memory, keyed by takeId. Backs whichever
// engine the HOOK itself constructs (sender or receiver, per test).
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  const state = {
    plans: new Map<string, unknown[]>(),
    planErrors: new Map<string, Error>(),
    partBytes: new Map<string, Uint8Array>(),
    committed: new Map<string, Set<string>>(),
    manifestCalls: [] as Array<{ episodeId: string; remote: unknown; from: string | null }>,
    writeManifestError: null as Error | null,
  };
  function reset(): void {
    state.plans.clear();
    state.planErrors.clear();
    state.partBytes.clear();
    state.committed.clear();
    state.manifestCalls.length = 0;
    state.writeManifestError = null;
  }
  return { state, reset, toHex };
});

vi.mock("@/lib/podcast/episodeStore", () => {
  class HashMismatchErrorMock extends Error {
    constructor(public partName: string) {
      super(`hash mismatch for ${partName}`);
      this.name = "HashMismatchError";
    }
  }
  return {
    HashMismatchError: HashMismatchErrorMock,
    readSendPlan: vi.fn(async (takeId: string) => {
      const err = H.state.planErrors.get(takeId);
      if (err) throw err;
      const plan = H.state.plans.get(takeId);
      if (!plan) throw new Error(`no fixture plan for ${takeId}`);
      return plan;
    }),
    openPartReader: vi.fn(async (takeId: string, name: string) => {
      const bytes = H.state.partBytes.get(`${takeId}:${name}`);
      if (!bytes) throw new Error(`no fixture bytes for ${takeId}:${name}`);
      return {
        size: bytes.length,
        read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
      };
    }),
    scanCommitted: vi.fn(async (takeId: string) => [...(H.state.committed.get(takeId) ?? new Set<string>())]),
    openIncomingPart: vi.fn(async (takeId: string, entry: SidecarEntry) => {
      const chunks: Uint8Array[] = [];
      return {
        append: async (bytes: Uint8Array) => {
          chunks.push(bytes);
        },
        commit: async () => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          const hex = H.toHex(await crypto.subtle.digest("SHA-256", merged));
          if (hex !== entry.sha256) throw new HashMismatchErrorMock(entry.name);
          let set = H.state.committed.get(takeId);
          if (!set) {
            set = new Set();
            H.state.committed.set(takeId, set);
          }
          set.add(entry.name);
        },
        abandon: async () => {},
      };
    }),
    writeManifest: vi.fn(async (takeId: string, remote: unknown, from: string | null) => {
      if (H.state.writeManifestError) throw H.state.writeManifestError;
      H.state.manifestCalls.push({ episodeId: takeId, remote, from });
    }),
  };
});

// ---------------------------------------------------------------------------
// fake XferPort — captures listener registration; `deliver`/`setChannelState`/
// `drain` let a test play frames as if from the peer; `wirePeer` routes the
// hook's own outbound sends into a real far-side engine.
// ---------------------------------------------------------------------------
class FakeXferPort implements XferPort {
  sent: Array<{ peerId: string; data: string | ArrayBuffer }> = [];
  private bufferedAmounts = new Map<string, number>();
  private messageListeners = new Set<(peerId: string, data: string | ArrayBuffer) => void>();
  private drainListeners = new Set<(peerId: string) => void>();
  private stateListeners = new Set<(peerId: string, channel: ChannelName, state: ChannelLifecycle) => void>();
  private sendOk = true;
  private peers = new Map<string, { handleFrame(from: string, data: string | ArrayBuffer): void }>();

  wirePeer(peerId: string, peer: { handleFrame(from: string, data: string | ArrayBuffer): void }): void {
    this.peers.set(peerId, peer);
  }

  send(peerId: string, data: string | ArrayBuffer): boolean {
    if (!this.sendOk) return false;
    this.sent.push({ peerId, data });
    const peer = this.peers.get(peerId);
    if (peer) queueMicrotask(() => peer.handleFrame(peerId, data));
    return true;
  }
  bufferedAmount(peerId: string): number {
    return this.bufferedAmounts.get(peerId) ?? -1;
  }
  onMessage(fn: (peerId: string, data: string | ArrayBuffer) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }
  onDrain(fn: (peerId: string) => void): () => void {
    this.drainListeners.add(fn);
    return () => this.drainListeners.delete(fn);
  }
  onChannelState(fn: (peerId: string, channel: ChannelName, state: ChannelLifecycle) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  // -- test driver ---------------------------------------------------------
  deliver(peerId: string, data: string | ArrayBuffer): void {
    for (const fn of this.messageListeners) fn(peerId, data);
  }
  drain(peerId: string): void {
    for (const fn of this.drainListeners) fn(peerId);
  }
  setChannelState(peerId: string, channel: ChannelName, state: ChannelLifecycle): void {
    for (const fn of this.stateListeners) fn(peerId, channel, state);
  }
  setSendOk(ok: boolean): void {
    this.sendOk = ok;
  }
  framesSentTo(peerId: string): Array<{ t: string; [k: string]: unknown }> {
    return this.sent
      .filter((s): s is { peerId: string; data: string } => s.peerId === peerId && typeof s.data === "string")
      .map((s) => JSON.parse(s.data) as { t: string; [k: string]: unknown });
  }
}

// ---------------------------------------------------------------------------
// far-side plain stores — real crypto.subtle hashing, no episodeStore mock
// involved (the far peer is not the hook under test).
// ---------------------------------------------------------------------------
async function toHexBuf(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

class FarSenderStore implements SenderStore {
  // One-shot gate on the FIRST openPartReader call — lets a test freeze the
  // exchange right after xfr/have (receiver already adopted, phase
  // "receiving") but before any part streams, so a transient state is
  // actually observable instead of racing straight to "done".
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  constructor(
    private readonly plan: FilePlan[],
    private readonly bytes: Map<string, Uint8Array>,
  ) {}

  pauseFirstOpen(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  resume(): void {
    this.release?.();
    this.gate = null;
  }

  async readSendPlan(): Promise<FilePlan[]> {
    return this.plan;
  }
  async openPartReader(_episodeId: string, name: string): Promise<PartReader> {
    if (this.gate) {
      await this.gate;
      this.gate = null;
    }
    const bytes = this.bytes.get(name);
    if (!bytes) throw new Error(`no fixture bytes for ${name}`);
    return {
      size: bytes.length,
      read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
    };
  }
}

class FarReceiverStore implements ReceiverStore {
  committedNames = new Set<string>();
  manifestCalls: Array<{ episodeId: string; remote: unknown; from: string | null }> = [];
  async scanCommitted(): Promise<string[]> {
    return [...this.committedNames];
  }
  async openIncomingPart(_episodeId: string, entry: SidecarEntry): Promise<IncomingPart> {
    const chunks: Uint8Array[] = [];
    return {
      append: async (bytes: Uint8Array) => {
        chunks.push(bytes);
      },
      commit: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        const hex = await toHexBuf(await crypto.subtle.digest("SHA-256", merged));
        if (hex !== entry.sha256) throw new HashMismatchError(entry.name);
        this.committedNames.add(entry.name);
      },
      abandon: async () => {},
    };
  }
  async writeManifest(episodeId: string, remote: unknown, from: string | null): Promise<void> {
    this.manifestCalls.push({ episodeId, remote, from });
  }
}

function farLink(port: FakeXferPort, peerId: string): XferLink {
  return {
    send: (data) => {
      queueMicrotask(() => port.deliver(peerId, data));
      return true;
    },
    bufferedAmount: () => 0,
  };
}

async function makePart(name: string, size: number, seed: number): Promise<{ entry: SidecarEntry; bytes: Uint8Array }> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (seed + i * 7) % 256;
  const sha256 = await toHexBuf(await crypto.subtle.digest("SHA-256", bytes));
  return { entry: { name, size, sha256 }, bytes };
}

// ---------------------------------------------------------------------------
// hook harness
// ---------------------------------------------------------------------------
const PEER = "peer-1";
const PEER2 = "peer-2";

function setup(overrides: Partial<EpisodeExchangeArgs> = {}) {
  const port = new FakeXferPort();
  const initialProps: EpisodeExchangeArgs = {
    enabled: true,
    xfer: port,
    xferKey: TEST_XFER_KEY,
    peerIds: [PEER],
    myCodename: "Nightingale",
    partnerCodename: "Falcon",
    lastTakeId: null,
    takeActive: false,
    dcOpen: true, // review fix round 2: default "call is up" — tests targeting this specifically override it
    ...overrides,
  };
  const view = renderHook((props: EpisodeExchangeArgs) => useEpisodeExchange(props), { initialProps });
  return { port, view };
}

beforeEach(() => {
  H.reset();
});

afterEach(() => {
  cleanup();
});

describe("useEpisodeExchange", () => {
  test("(a) canSend truth table: lastTakeId, exactly one peer, xfer open, no take active", () => {
    // lastTakeId null -> false regardless of an open channel
    {
      const { port, view } = setup({ lastTakeId: null });
      act(() => port.setChannelState(PEER, "xfer", "open"));
      expect(view.result.current.canSend).toBe(false);
    }
    // channel not (yet) reported open -> false
    {
      const { view } = setup({ lastTakeId: "take-1" });
      expect(view.result.current.canSend).toBe(false);
    }
    // not exactly one peer -> false, even with an "open" report for one of them
    {
      const { port, view } = setup({ lastTakeId: "take-1", peerIds: [PEER, "peer-2"] });
      act(() => port.setChannelState(PEER, "xfer", "open"));
      expect(view.result.current.canSend).toBe(false);
    }
    // zero peers -> false
    {
      const { view } = setup({ lastTakeId: "take-1", peerIds: [] });
      expect(view.result.current.canSend).toBe(false);
    }
    // a take in progress -> false even with everything else true
    {
      const { port, view } = setup({ lastTakeId: "take-1", takeActive: true });
      act(() => port.setChannelState(PEER, "xfer", "open"));
      expect(view.result.current.canSend).toBe(false);
    }
    // every condition true -> true
    {
      const { port, view } = setup({ lastTakeId: "take-1" });
      expect(view.result.current.canSend).toBe(false);
      act(() => port.setChannelState(PEER, "xfer", "open"));
      expect(view.result.current.canSend).toBe(true);
    }
    // Review fix (Phase 5D round 2, UX): dcOpen false -> canSend false even
    // with the xfer channel itself reporting open — the sub-second window
    // during a 4C re-proof where the raw "cos-xfer" channel has reopened
    // but the fresh join-proof (and therefore mesh's proven-gated dcOpen)
    // hasn't completed yet, so sendXferTo would still refuse underneath.
    {
      const { port, view } = setup({ lastTakeId: "take-1", dcOpen: false });
      act(() => port.setChannelState(PEER, "xfer", "open"));
      expect(view.result.current.canSend).toBe(false);
    }
  });

  test("(b) send() offers on the wire; the far peer (real EpisodeReceiver) commits both parts; state walks sending -> done, busy true throughout", async () => {
    const takeId = "take-b";
    const audio = await makePart("audio.part000", 200, 1);
    const video = await makePart("video.part000", 300, 90);
    H.state.plans.set(takeId, [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [video.entry] },
    ]);
    H.state.partBytes.set(`${takeId}:audio.part000`, audio.bytes);
    H.state.partBytes.set(`${takeId}:video.part000`, video.bytes);

    const { port, view } = setup({ lastTakeId: takeId });
    act(() => port.setChannelState(PEER, "xfer", "open"));
    expect(view.result.current.canSend).toBe(true);

    const farStore = new FarReceiverStore();
    const farReceiver = new EpisodeReceiver(PEER, farLink(port, PEER), farStore, {
      onPhase: vi.fn(),
      onProgress: vi.fn(),
    }, TEST_XFER_KEY);
    port.wirePeer(PEER, farReceiver);

    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.state).toBeNull();

    act(() => view.result.current.actions.send());
    expect(view.result.current.busy).toBe(true);

    await waitFor(() => {
      expect(view.result.current.state?.kind).toBe("xfer-sending");
    });
    expect(view.result.current.busy).toBe(true);

    await waitFor(() => {
      expect(view.result.current.state).toEqual({ kind: "xfer-done", direction: "send", totalBytes: 500 });
    });
    expect(view.result.current.busy).toBe(false);
    expect(farStore.committedNames).toEqual(new Set(["audio.part000", "video.part000"]));
    expect(farStore.manifestCalls).toHaveLength(1);

    // (i) D8: the offer's `from` is the SENDER's OWN codename (myCodename),
    // never the sender's view of the partner — and the receiver persists
    // that exact value as manifest.receivedFrom.
    const offer = port.framesSentTo(PEER).find((f) => f.t === "xfr/offer");
    expect(offer?.from).toBe("Nightingale");
    expect(farStore.manifestCalls[0]?.from).toBe("Nightingale");
  });

  test("(c) an inbound offer lazily creates the receiver and shows this hook's own partnerCodename arg; completes to xfer-done", async () => {
    const takeId = "take-c";
    const audio = await makePart("audio.part000", 150, 5);
    const video = await makePart("video.part000", 250, 40);
    const plan: FilePlan[] = [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [video.entry] },
    ];
    const farStore = new FarSenderStore(
      plan,
      new Map([
        [audio.entry.name, audio.bytes],
        [video.entry.name, video.bytes],
      ]),
    );
    farStore.pauseFirstOpen(); // freeze right after xfr/have — see FarSenderStore's comment

    // The receiving copy's fromCodename rides this hook's OWN partnerCodename
    // arg (available the instant an offer is adopted), not the wire's `from`
    // field (which the engine only surfaces via ReceiveProgress, i.e. not
    // until the first chunk lands) — the far sender's own `from` value below
    // is deliberately something else, to prove it is NOT what gets displayed.
    const { port, view } = setup({ lastTakeId: null, partnerCodename: "Otter" });
    const farSender = new EpisodeSender(PEER, farLink(port, PEER), farStore, { onPhase: vi.fn(), onProgress: vi.fn() }, TEST_XFER_KEY);
    port.wirePeer(PEER, farSender);

    expect(view.result.current.state).toBeNull();
    act(() => farSender.start(takeId, "wire-from-value-is-not-displayed"));

    await waitFor(() => {
      expect(view.result.current.state?.kind).toBe("xfer-receiving");
    });
    expect(view.result.current.state).toMatchObject({ kind: "xfer-receiving", fromCodename: "Otter" });
    expect(view.result.current.busy).toBe(true);

    farStore.resume();
    await waitFor(() => {
      expect(view.result.current.state).toEqual({ kind: "xfer-done", direction: "receive", totalBytes: 400 });
    });
    expect(view.result.current.busy).toBe(false);
  });

  test("(d) a channel close mid-send parks the transfer; canResend flips true once the channel reopens; resend() re-offers", async () => {
    const takeId = "take-d";
    const audio = await makePart("audio.part000", 100, 3);
    H.state.plans.set(takeId, [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [] },
    ]);
    H.state.partBytes.set(`${takeId}:audio.part000`, audio.bytes);

    const { port, view } = setup({ lastTakeId: takeId });
    act(() => port.setChannelState(PEER, "xfer", "open"));

    // Fire the close in the SAME synchronous batch as send(): the engine's
    // phase flips to "offering" synchronously inside sender.start(), well
    // before any awaited disk/network op — no gating needed to catch it
    // mid-flight.
    act(() => {
      view.result.current.actions.send();
      port.setChannelState(PEER, "xfer", "closed");
    });

    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });
    expect(view.result.current.busy).toBe(false);

    act(() => port.setChannelState(PEER, "xfer", "open"));
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: true });

    const offersBefore = port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length;
    act(() => view.result.current.actions.resend());
    // sender.start()'s "offering" phase (and this hook's busy/state
    // derived from it) flips synchronously; the actual xfr/offer frame
    // waits on readSendPlan()'s microtask, so the wire assertion needs a
    // tick.
    expect(view.result.current.state?.kind).toBe("xfer-sending");
    expect(view.result.current.busy).toBe(true);

    await waitFor(() => {
      const offersAfter = port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length;
      expect(offersAfter).toBe(offersBefore + 1);
    });
  });

  test("(d2) canResend/resend() stay gated while dcOpen is false, even once the xfer channel itself reopens (Phase 5D round 2 review fix)", async () => {
    const takeId = "take-d2";
    const audio = await makePart("audio.part000", 100, 3);
    H.state.plans.set(takeId, [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [] },
    ]);
    H.state.partBytes.set(`${takeId}:audio.part000`, audio.bytes);

    const { port, view } = setup({ lastTakeId: takeId });
    act(() => port.setChannelState(PEER, "xfer", "open"));
    act(() => {
      view.result.current.actions.send();
      port.setChannelState(PEER, "xfer", "closed");
    });
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });

    // The xfer channel reopens, but dcOpen (the proven-gated aggregate) is
    // still false — a 4C re-proof in flight. canResend must stay false, and
    // resend() must be a genuine no-op, not a silent send into a channel
    // sendXferTo would refuse underneath.
    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: takeId,
        takeActive: false,
        dcOpen: false,
        xferKey: TEST_XFER_KEY,
      });
    });
    act(() => port.setChannelState(PEER, "xfer", "open"));
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });

    const offersBefore = port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length;
    act(() => view.result.current.actions.resend());
    expect(port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length).toBe(offersBefore);
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });

    // Once dcOpen genuinely goes true, the same reopened channel unlocks it.
    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: takeId,
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: true });
  });

  test("channel-closed wiring reaches the receiver too: a close during an inbound transfer parks it", () => {
    const takeId = "take-park-recv";
    const { port, view } = setup({ lastTakeId: null });

    act(() => {
      port.deliver(
        PEER,
        JSON.stringify({
          t: "xfr/offer",
          v: 1,
          episodeId: takeId,
          from: "Otter",
          files: [
            { base: "audio", parts: [{ name: "audio.part000", size: 10, sha256: "x" }] },
            { base: "video", parts: [] },
          ],
        }),
      );
      port.setChannelState(PEER, "xfer", "closed");
    });

    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "receive", canResend: false });
    expect(view.result.current.busy).toBe(false);
  });

  test("an inbound xfr/fault mid-receive parks the receiving card, releases busy, and is dismissible", () => {
    const takeId = "take-peer-fault";
    const { port, view } = setup({ lastTakeId: null });

    act(() => {
      port.deliver(
        PEER,
        JSON.stringify({
          t: "xfr/offer",
          v: 1,
          episodeId: takeId,
          from: "Otter",
          files: [
            { base: "audio", parts: [{ name: "audio.part000", size: 10, sha256: "x" }] },
            { base: "video", parts: [] },
          ],
        }),
      );
    });
    expect(view.result.current.state?.kind).toBe("xfer-receiving");
    expect(view.result.current.busy).toBe(true);

    // The far sender hit a real error on ITS side (plan:/open:/read:, or a
    // malformed frame from us) and gave up. Without the receiver honoring
    // this frame the card stayed "receiving" forever, busy stayed true, and
    // holdRolls blocked every future take on this host.
    act(() => {
      port.deliver(PEER, JSON.stringify({ t: "xfr/fault", v: 1, episodeId: takeId, reason: "read:disk gone" }));
    });

    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "receive", canResend: false });
    expect(view.result.current.busy).toBe(false);

    act(() => view.result.current.actions.dismiss());
    expect(view.result.current.state).toBeNull();
  });

  // -------------------------------------------------------------------
  // Peer churn (fix round: findings #2/#3/#4). The harness below extends
  // setup()'s single-peer pin via view.rerender, rather than working
  // around it, per the review.
  // -------------------------------------------------------------------

  test("(ii) peer churn: after P1 leaves and P2 joins, P2's offer creates a fresh receiver instead of being dropped forever", async () => {
    // A signal that can't be faked by the receiving copy's own display
    // logic (which rides the hook's partnerCodename arg, not engine state):
    // take-p2's only part is pre-seeded as ALREADY committed on disk, so a
    // GENUINE rebind+adopt finishes the episode immediately (scanCommitted
    // -> allPartsCommitted() true -> writeManifest -> "done"). If the
    // receiver instead stays wedged on P1 (the bug), this can never fire —
    // scanCommitted for take-p2 is never even called.
    H.state.committed.set("take-p2", new Set(["audio.part000"]));

    const { port, view } = setup({ lastTakeId: null, peerIds: [PEER], partnerCodename: "P1Name" });

    act(() => {
      port.deliver(
        PEER,
        JSON.stringify({
          t: "xfr/offer",
          v: 1,
          episodeId: "take-p1",
          from: "P1Name",
          files: [
            { base: "audio", parts: [{ name: "audio.part000", size: 100, sha256: "deadbeef" }] },
            { base: "video", parts: [] },
          ],
        }),
      );
    });
    // Adopted, sent xfr/have, and now sits waiting for xfr/part that never
    // comes in this test — a stable "receiving" window, no gate needed.
    expect(view.result.current.state).toMatchObject({ kind: "xfer-receiving", fromCodename: "P1Name" });

    // P1 leaves, P2 joins — a genuine roster swap (NOT a 4C link rebuild,
    // which keeps the same peerId and must never hit the rebind branch).
    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER2],
        myCodename: "Nightingale",
        partnerCodename: "P2Name",
        lastTakeId: null,
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });

    act(() => {
      port.deliver(
        PEER2,
        JSON.stringify({
          t: "xfr/offer",
          v: 1,
          episodeId: "take-p2",
          from: "P2Name",
          files: [
            { base: "audio", parts: [{ name: "audio.part000", size: 50, sha256: "cafebabe" }] },
            { base: "video", parts: [] },
          ],
        }),
      );
    });

    // Before the fix: the receiver stayed bound to PEER, the peerId guard
    // on forwarding never matched PEER2, and this frame was silently
    // dropped forever — take-p2 never reaches "done" because scanCommitted
    // is never even called for it. After the fix: rebind, adopt, finish.
    // (totalBytes is 0 here — an all-already-committed episode streams
    // nothing, so no ReceiveProgress ever fires to report a size; a
    // pre-existing, orthogonal gap this test isn't about, so not asserted.)
    await waitFor(() => {
      expect(view.result.current.state).toMatchObject({ kind: "xfer-done", direction: "receive" });
    });
  });

  test("(iii) canSend survives a transient third peer: [P1] -> [P1,P2] -> [P1] with P1's channel open throughout", () => {
    const { port, view } = setup({ lastTakeId: "take-1", peerIds: [PEER] });
    act(() => port.setChannelState(PEER, "xfer", "open"));
    expect(view.result.current.canSend).toBe(true);

    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER, PEER2],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: "take-1",
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });
    // Not exactly one peer -> false, even though P1's channel is still open.
    expect(view.result.current.canSend).toBe(false);

    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: "take-1",
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });
    // Back to exactly one peer. P1's channel never actually closed — no
    // fresh onChannelState("open") event fires here — so a single boolean
    // reset on peerKey change would wedge this false forever. The per-peer
    // map must remember P1 was already open.
    expect(view.result.current.canSend).toBe(true);
  });

  test("(iv) resend() after a peer swap does not fire at the departed peer", async () => {
    const takeId = "take-iv";
    const audio = await makePart("audio.part000", 60, 7);
    H.state.plans.set(takeId, [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [] },
    ]);
    H.state.partBytes.set(`${takeId}:audio.part000`, audio.bytes);

    const { port, view } = setup({ lastTakeId: takeId, peerIds: [PEER] });
    act(() => port.setChannelState(PEER, "xfer", "open"));

    act(() => {
      view.result.current.actions.send();
      port.setChannelState(PEER, "xfer", "closed");
    });
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });

    // PEER (the parked transfer's peer) leaves; PEER2 joins and opens.
    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER2],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: takeId,
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });
    act(() => port.setChannelState(PEER2, "xfer", "open"));

    // canResend stays false — the parked sender's peer isn't the current
    // single peer, regardless of PEER2's channel being open.
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });

    const offersToOldPeerBefore = port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length;
    const offersToNewPeerBefore = port.framesSentTo(PEER2).filter((f) => f.t === "xfr/offer").length;

    act(() => view.result.current.actions.resend());

    expect(port.framesSentTo(PEER).filter((f) => f.t === "xfr/offer").length).toBe(offersToOldPeerBefore);
    expect(port.framesSentTo(PEER2).filter((f) => f.t === "xfr/offer").length).toBe(offersToNewPeerBefore);
    // Still parked — resend() was a genuine no-op, not a silent success
    // into the void.
    expect(view.result.current.state).toEqual({ kind: "xfer-interrupted", direction: "send", canResend: false });
  });

  test("(v) GLOBAL CONSTRAINT: an offer arriving while a take is rolling is dropped outright; a re-offer after the take ends adopts normally", async () => {
    const offer = JSON.stringify({
      t: "xfr/offer",
      v: 1,
      episodeId: "take-mid-roll",
      from: "Otter",
      files: [
        { base: "audio", parts: [{ name: "audio.part000", size: 10, sha256: "x" }] },
        { base: "video", parts: [] },
      ],
    });

    const { port, view } = setup({ lastTakeId: null, takeActive: true });

    act(() => port.deliver(PEER, offer));

    // No receiver created, no state change, nothing acknowledged on the wire
    // — the far sender's own OFFER_TIMEOUT_MS parks them, which is the
    // spec's answer for an unanswered offer.
    expect(view.result.current.state).toBeNull();
    expect(view.result.current.busy).toBe(false);
    expect(port.framesSentTo(PEER)).toEqual([]);

    act(() => {
      view.rerender({
        enabled: true,
        xfer: port,
        peerIds: [PEER],
        myCodename: "Nightingale",
        partnerCodename: "Falcon",
        lastTakeId: null,
        takeActive: false,
        dcOpen: true,
        xferKey: TEST_XFER_KEY,
      });
    });

    act(() => port.deliver(PEER, offer));

    expect(view.result.current.state).toMatchObject({ kind: "xfer-receiving" });
    expect(view.result.current.busy).toBe(true);
    await waitFor(() => {
      expect(port.framesSentTo(PEER).filter((f) => f.t === "xfr/have")).toHaveLength(1);
    });
  });

  test("(e) dismiss() clears a done card", async () => {
    const takeId = "take-e";
    const audio = await makePart("audio.part000", 60, 2);
    H.state.plans.set(takeId, [
      { base: "audio", parts: [audio.entry] },
      { base: "video", parts: [] },
    ]);
    H.state.partBytes.set(`${takeId}:audio.part000`, audio.bytes);

    const { port, view } = setup({ lastTakeId: takeId });
    act(() => port.setChannelState(PEER, "xfer", "open"));

    const farStore = new FarReceiverStore();
    const farReceiver = new EpisodeReceiver(PEER, farLink(port, PEER), farStore, {
      onPhase: vi.fn(),
      onProgress: vi.fn(),
    }, TEST_XFER_KEY);
    port.wirePeer(PEER, farReceiver);

    act(() => view.result.current.actions.send());
    await waitFor(() => expect(view.result.current.state?.kind).toBe("xfer-done"));

    act(() => view.result.current.actions.dismiss());
    expect(view.result.current.state).toBeNull();
  });

  // Ledgered edge case (Task 10 carry-in): lastTakeId can name a take with
  // zero tape on disk (stop landed mid-start-chain). send() on such a take:
  // readSendPlan rejects, the sender faults with a plan error, and the
  // xfer-fault card renders sanely and is dismissible — no crash.
  test("a take with zero tape on disk faults the sender on send() with a dismissible plan-rejection card", async () => {
    const takeId = "take-empty";
    H.state.planErrors.set(takeId, new Error("no such file: audio.sidecar.json"));

    const { port, view } = setup({ lastTakeId: takeId });
    act(() => port.setChannelState(PEER, "xfer", "open"));
    expect(view.result.current.canSend).toBe(true);

    expect(() => act(() => view.result.current.actions.send())).not.toThrow();

    await waitFor(() => {
      expect(view.result.current.state?.kind).toBe("xfer-fault");
    });
    expect(view.result.current.state).toMatchObject({
      kind: "xfer-fault",
      reason: expect.stringContaining("plan:"),
    });
    expect(view.result.current.busy).toBe(false);

    act(() => view.result.current.actions.dismiss());
    expect(view.result.current.state).toBeNull();
    // Binding context: dismiss() from a fault card must return to an armed
    // state where canSend is genuinely live (the fault card's "Resume to
    // send it again" copy's only real path is Stand Down -> armed -> Send).
    expect(view.result.current.canSend).toBe(true);
  });

  test("(f) mergePanel: a take in progress always outranks a non-null exchange state", () => {
    const sendingState: ExchangePanelState = {
      kind: "xfer-sending",
      file: "audio.part000",
      sentBytes: 1,
      totalBytes: 2,
      mbps: 1,
      etaS: null,
    };
    const xchg = fakeExchange({ state: sendingState });
    const takeStates: PodcastPanelState[] = [
      { kind: "countdown", secondsLeft: 3 },
      { kind: "rolling", elapsedS: 1, localBytes: 0, partnerBytes: 0, partnerCodename: null },
      { kind: "stopping" },
      { kind: "fault", faults: [], partnerCodename: null },
    ];
    for (const take of takeStates) {
      expect(mergePanel(take, xchg)).toEqual(take);
    }
  });

  test("(f) mergePanel: a non-null exchange state outranks armed and every readiness-gate kind", () => {
    const doneState: ExchangePanelState = { kind: "xfer-done", direction: "receive", totalBytes: 5 };
    const xchg = fakeExchange({ state: doneState });
    const takeStates: PodcastPanelState[] = [
      { kind: "armed", canSend: true },
      { kind: "not-two", count: 3 },
      { kind: "vault-needed", permission: "unset" },
      { kind: "link-down" },
      { kind: "unsupported" },
    ];
    for (const take of takeStates) {
      expect(mergePanel(take, xchg)).toEqual(doneState);
    }
  });

  test("(f) mergePanel: armed gains canSend from the exchange when no exchange state is showing", () => {
    expect(mergePanel({ kind: "armed", canSend: false }, fakeExchange({ canSend: true }))).toEqual({
      kind: "armed",
      canSend: true,
    });
    expect(mergePanel({ kind: "armed", canSend: true }, fakeExchange({ canSend: false }))).toEqual({
      kind: "armed",
      canSend: false,
    });
  });

  test("(f) mergePanel: every other take kind passes through unchanged when no exchange state is showing", () => {
    const xchg = fakeExchange({});
    const takeStates: PodcastPanelState[] = [
      { kind: "not-two", count: 2 },
      { kind: "vault-needed", permission: "prompt" },
      { kind: "link-down" },
      { kind: "unsupported" },
    ];
    for (const take of takeStates) {
      expect(mergePanel(take, xchg)).toEqual(take);
    }
  });
});

function fakeExchange(overrides: Partial<EpisodeExchange>): EpisodeExchange {
  return {
    state: null,
    busy: false,
    canSend: false,
    actions: { send: vi.fn(), resend: vi.fn(), dismiss: vi.fn() },
    debug: { kind: null, sentBytes: 0, committedBytes: 0, totalBytes: 0, resumedParts: null },
    ...overrides,
  };
}
