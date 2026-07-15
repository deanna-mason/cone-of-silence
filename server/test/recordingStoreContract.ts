import { expect, it } from "vitest";
import type { RecordingStore } from "../src/studio/types.js";

export function recordingStoreContract(makeStore: (userIds: string[]) => Promise<RecordingStore>, ids: string[]) {
  const [alice, bob] = ids;
  if (!alice || !bob) throw new Error("recordingStoreContract requires two ids");

  it("creates queued and lists per-user, newest first", async () => {
    const store = await makeStore(ids);
    const a1 = await store.create(alice, "ep1.mp3", ".mp3");
    expect(a1.status).toBe("queued");
    await store.create(alice, "ep2.mp4", ".mp4");
    await store.create(bob, "other.wav", ".wav");
    const mine = await store.listByUser(alice);
    expect(mine.map((r) => r.originalName)).toEqual(["ep2.mp4", "ep1.mp3"]);
  });

  it("claims oldest queued exactly once and recovers stale", async () => {
    const store = await makeStore(ids);
    const first = await store.create(alice, "first.mp3", ".mp3");
    await store.create(alice, "second.mp3", ".mp3");
    const claimed = await store.claimNextQueued();
    expect(claimed?.id).toBe(first.id);
    expect((await store.get(first.id))?.status).toBe("processing");
    await store.recoverStale();
    expect((await store.get(first.id))?.status).toBe("queued");
  });

  it("setStatus stores an error message; remove deletes; get of stranger id is null", async () => {
    const store = await makeStore(ids);
    const rec = await store.create(alice, "bad.mp3", ".mp3");
    await store.setStatus(rec.id, "error", "ffmpeg exploded");
    const got = await store.get(rec.id);
    expect(got?.status).toBe("error");
    expect(got?.error).toBe("ffmpeg exploded");
    await store.remove(rec.id);
    expect(await store.get(rec.id)).toBeNull();
  });
}
