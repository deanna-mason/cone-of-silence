import type { SupabaseClient } from "@supabase/supabase-js";
import { generateToken, hashToken } from "./crypto.js";
import {
  Grant,
  GrantNotFoundError,
  StoreUnavailableError,
  TokenEvent,
  TokenEventKind,
  TokenKind,
  TokenStore,
  VerifyResult,
} from "./types.js";

interface TokenRow {
  id: string;
  label: string;
  kind: TokenKind;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface EventRow {
  id: number;
  token_id: string;
  event: TokenEventKind;
  occurred_at: string;
  detail: Record<string, unknown> | null;
}

function rowToGrant(row: TokenRow): Grant {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export class SupabaseTokenStore implements TokenStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(context: string, message: string): never {
    throw new StoreUnavailableError(`${context}: ${message}`);
  }

  private async addEvent(
    tokenId: string,
    event: TokenEventKind,
    detail: Record<string, unknown> | null = null,
  ): Promise<void> {
    const { error } = await this.db
      .from("token_events")
      .insert({ token_id: tokenId, event, detail });
    if (error) this.fail("addEvent", error.message);
  }

  private async getRow(id: string): Promise<TokenRow> {
    const { data, error } = await this.db
      .from("creation_tokens")
      .select("*")
      .eq("id", id)
      .maybeSingle<TokenRow>();
    // Invalid UUID input (code 22P02) cannot name any grant — treat as not found.
    // Any other error is a real outage/auth failure and must fail closed.
    if (error) {
      if (error.code === "22P02") throw new GrantNotFoundError(id);
      this.fail("getRow", error.message);
    }
    if (!data) throw new GrantNotFoundError(id);
    return data;
  }

  private async updateRow(id: string, patch: Partial<TokenRow>): Promise<Grant> {
    const { data, error } = await this.db
      .from("creation_tokens")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle<TokenRow>();
    if (error) {
      if (error.code === "22P02") throw new GrantNotFoundError(id);
      this.fail("updateRow", error.message);
    }
    if (!data) throw new GrantNotFoundError(id);
    return rowToGrant(data);
  }

  async verify(
    token: string,
    opts?: { touch?: boolean; kind?: TokenKind },
  ): Promise<VerifyResult> {
    const { data, error } = await this.db
      .from("creation_tokens")
      .select("*")
      .eq("token_hash", hashToken(token))
      .maybeSingle<TokenRow>();
    if (error) this.fail("verify", error.message);
    if (!data) return { ok: false, reason: "invalid" };
    if (data.revoked_at) return { ok: false, reason: "revoked" };
    if (data.kind !== (opts?.kind ?? "room-creation")) return { ok: false, reason: "invalid" };
    if (opts?.touch !== false) {
      const touched = await this.updateRow(data.id, {
        last_used_at: new Date().toISOString(),
      });
      return { ok: true, grant: touched };
    }
    return { ok: true, grant: rowToGrant(data) };
  }

  async mint(
    label: string,
    kind: TokenKind = "room-creation",
  ): Promise<{ token: string; grant: Grant }> {
    const token = generateToken();
    const { data, error } = await this.db
      .from("creation_tokens")
      .insert({ label, kind, token_hash: hashToken(token) })
      .select()
      .single<TokenRow>();
    if (error || !data) this.fail("mint", error?.message ?? "no row returned");
    await this.addEvent(data.id, "minted");
    return { token, grant: rowToGrant(data) };
  }

  async redeem(token: string): Promise<VerifyResult> {
    const { data: row, error } = await this.db
      .from("creation_tokens")
      .select("*")
      .eq("token_hash", hashToken(token))
      .maybeSingle<TokenRow>();
    if (error) this.fail("redeem", error.message);
    if (!row || row.kind !== "signup") return { ok: false, reason: "invalid" };
    if (row.revoked_at) return { ok: false, reason: "revoked" };
    const now = new Date().toISOString();
    const { data: won, error: updErr } = await this.db
      .from("creation_tokens")
      .update({ revoked_at: now, last_used_at: now })
      .eq("id", row.id)
      .is("revoked_at", null) // loser of a race updates zero rows
      .select()
      .maybeSingle<TokenRow>();
    if (updErr) this.fail("redeem", updErr.message);
    if (!won) return { ok: false, reason: "revoked" };
    await this.addEvent(row.id, "redeemed");
    return { ok: true, grant: rowToGrant(won) };
  }

  async list(): Promise<Grant[]> {
    const { data, error } = await this.db
      .from("creation_tokens")
      .select("*")
      .order("created_at", { ascending: true })
      .returns<TokenRow[]>();
    if (error) this.fail("list", error.message);
    return (data ?? []).map(rowToGrant);
  }

  async listEvents(tokenId: string): Promise<TokenEvent[]> {
    const { data, error } = await this.db
      .from("token_events")
      .select("*")
      .eq("token_id", tokenId)
      .order("id", { ascending: true })
      .returns<EventRow[]>();
    if (error) this.fail("listEvents", error.message);
    return (data ?? []).map((row) => ({
      id: String(row.id),
      tokenId: row.token_id,
      event: row.event,
      occurredAt: row.occurred_at,
      detail: row.detail,
    }));
  }

  async relabel(id: string, label: string): Promise<Grant> {
    const before = await this.getRow(id);
    const grant = await this.updateRow(id, { label });
    await this.addEvent(id, "relabeled", { from: before.label, to: label });
    return grant;
  }

  async revoke(id: string): Promise<Grant> {
    await this.getRow(id); // 404 before write
    const grant = await this.updateRow(id, { revoked_at: new Date().toISOString() });
    await this.addEvent(id, "revoked");
    return grant;
  }

  async restore(id: string): Promise<Grant> {
    await this.getRow(id);
    const grant = await this.updateRow(id, { revoked_at: null });
    await this.addEvent(id, "restored");
    return grant;
  }

  async purge(id: string): Promise<void> {
    await this.getRow(id);
    const { error } = await this.db.from("creation_tokens").delete().eq("id", id);
    if (error) this.fail("purge", error.message); // events cascade via FK
  }
}
