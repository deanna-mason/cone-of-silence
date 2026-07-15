export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface SessionInfo {
  userId: string;
  username: string;
  expiresAt: string;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username already taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export interface AccountStore {
  createUser(username: string, passwordHash: string): Promise<User>; // throws UsernameTakenError
  getCredentials(username: string): Promise<{ user: User; passwordHash: string } | null>;
  createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  getSession(tokenHash: string): Promise<SessionInfo | null>; // expired ⇒ null (and lazily deleted)
  deleteSession(tokenHash: string): Promise<void>;
}
