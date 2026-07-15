import { randomUUID } from "node:crypto";
import type { AccountStore, SessionInfo, User } from "../src/accounts/types.js";
import { UsernameTakenError } from "../src/accounts/types.js";

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
