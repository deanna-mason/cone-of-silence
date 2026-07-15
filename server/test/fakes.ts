import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import type { AccountStore, SessionInfo, User } from "../src/accounts/types.js";
import { UsernameTakenError } from "../src/accounts/types.js";
import type { Recording, RecordingStatus, RecordingStore } from "../src/studio/types.js";
import type { TokenStore } from "../src/tokens/types.js";

/** Mints a signup token, signs up, and returns a ready-to-use Authorization bearer value. */
export async function signupAndLogin(
  app: Express,
  store: TokenStore,
  username: string,
  password = "opensesame",
): Promise<string> {
  const { token } = await store.mint(username, "signup");
  const res = await request(app)
    .post("/auth/signup")
    .send({ token, username, password });
  return `Bearer ${res.body.session as string}`;
}

interface StoredUser extends User { passwordHash: string }
interface StoredSession { userId: string; tokenHash: string; expiresAt: string }

export class FakeAccountStore implements AccountStore {
  users: StoredUser[] = [];
  sessions: StoredSession[] = [];

  async createUser(username: string, passwordHash: string): Promise<User> {
    if (this.users.some((u) => u.username === username)) throw new UsernameTakenError(username);
    const user: StoredUser = {
      id: randomUUID(),
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    const { passwordHash: _ph, ...pub } = user;
    return pub;
  }

  async getCredentials(username: string) {
    const u = this.users.find((x) => x.username === username);
    if (!u) return null;
    const { passwordHash, ...user } = u;
    return { user, passwordHash };
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string) {
    this.sessions.push({ userId, tokenHash, expiresAt });
  }

  async getSession(tokenHash: string): Promise<SessionInfo | null> {
    const s = this.sessions.find((x) => x.tokenHash === tokenHash);
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= Date.now()) {
      await this.deleteSession(tokenHash);
      return null;
    }
    const u = this.users.find((x) => x.id === s.userId);
    if (!u) return null;
    return { userId: u.id, username: u.username, expiresAt: s.expiresAt };
  }

  async deleteSession(tokenHash: string) {
    this.sessions = this.sessions.filter((x) => x.tokenHash !== tokenHash);
  }
}

// Insertion-order tiebreaker: Date.now() resolution can collide within a fast
// test run, and the fake must not rely on wall-clock precision for ordering.
interface StoredRecording extends Recording { seq: number }

export class FakeRecordingStore implements RecordingStore {
  recordings: StoredRecording[] = [];
  private nextSeq = 0;

  async create(userId: string, originalName: string, sourceExt: string): Promise<Recording> {
    const now = new Date().toISOString();
    const rec: StoredRecording = {
      id: randomUUID(),
      userId,
      originalName,
      sourceExt,
      status: "queued",
      error: null,
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq++,
    };
    this.recordings.push(rec);
    const { seq: _seq, ...pub } = rec;
    return { ...pub };
  }

  async listByUser(userId: string): Promise<Recording[]> {
    return this.recordings
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq)
      .map(({ seq: _seq, ...r }) => ({ ...r }));
  }

  async get(id: string): Promise<Recording | null> {
    const r = this.recordings.find((x) => x.id === id);
    if (!r) return null;
    const { seq: _seq, ...pub } = r;
    return { ...pub };
  }

  async setStatus(id: string, status: RecordingStatus, error: string | null = null): Promise<void> {
    const r = this.recordings.find((x) => x.id === id);
    if (!r) return;
    r.status = status;
    r.error = error;
    r.updatedAt = new Date().toISOString();
  }

  async remove(id: string): Promise<void> {
    this.recordings = this.recordings.filter((x) => x.id !== id);
  }

  async claimNextQueued(): Promise<Recording | null> {
    const next = this.recordings
      .filter((r) => r.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq)[0];
    if (!next) return null;
    next.status = "processing";
    next.updatedAt = new Date().toISOString();
    const { seq: _seq, ...pub } = next;
    return { ...pub };
  }

  async recoverStale(): Promise<void> {
    for (const r of this.recordings) if (r.status === "processing") r.status = "queued";
  }
}
