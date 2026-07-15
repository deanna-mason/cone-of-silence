import type { SupabaseClient } from "@supabase/supabase-js";
import { StoreUnavailableError } from "../tokens/types.js";
import { UsernameTakenError, type AccountStore, type SessionInfo, type User } from "./types.js";

interface UserRow { id: string; username: string; password_hash: string; created_at: string }

export class SupabaseAccountStore implements AccountStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(context: string, message: string): never {
    throw new StoreUnavailableError(`${context}: ${message}`);
  }

  async createUser(username: string, passwordHash: string): Promise<User> {
    const { data, error } = await this.db
      .from("users")
      .insert({ username, password_hash: passwordHash })
      .select()
      .single<UserRow>();
    if (error) {
      if (error.code === "23505") throw new UsernameTakenError(username);
      this.fail("createUser", error.message);
    }
    if (!data) this.fail("createUser", "no row returned");
    return { id: data.id, username: data.username, createdAt: data.created_at };
  }

  async getCredentials(username: string) {
    const { data, error } = await this.db
      .from("users")
      .select("*")
      .eq("username", username)
      .maybeSingle<UserRow>();
    if (error) this.fail("getCredentials", error.message);
    if (!data) return null;
    return {
      user: { id: data.id, username: data.username, createdAt: data.created_at },
      passwordHash: data.password_hash,
    };
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    const { error } = await this.db
      .from("sessions")
      .insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
    if (error) this.fail("createSession", error.message);
  }

  async getSession(tokenHash: string): Promise<SessionInfo | null> {
    const { data, error } = await this.db
      .from("sessions")
      .select("user_id, expires_at, users(username)")
      .eq("token_hash", tokenHash)
      .maybeSingle<{ user_id: string; expires_at: string; users: { username: string } }>();
    if (error) this.fail("getSession", error.message);
    if (!data) return null;
    if (Date.parse(data.expires_at) <= Date.now()) {
      await this.deleteSession(tokenHash); // lazy cleanup
      return null;
    }
    return { userId: data.user_id, username: data.users.username, expiresAt: data.expires_at };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    const { error } = await this.db.from("sessions").delete().eq("token_hash", tokenHash);
    if (error) this.fail("deleteSession", error.message);
  }
}
