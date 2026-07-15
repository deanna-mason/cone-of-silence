export type TokenKind = "room-creation" | "signup";

export interface Grant {
  id: string;
  label: string;
  kind: TokenKind;
  createdAt: string; // ISO 8601
  lastUsedAt: string | null;
  revokedAt: string | null; // null = active
}

export type VerifyResult =
  | { ok: true; grant: Grant }
  | { ok: false; reason: "invalid" | "revoked" };

export type TokenEventKind = "minted" | "relabeled" | "revoked" | "restored" | "redeemed";

export interface TokenEvent {
  id: string;
  tokenId: string;
  event: TokenEventKind;
  occurredAt: string;
  detail: Record<string, unknown> | null;
}

export class GrantNotFoundError extends Error {
  constructor(id: string) {
    super(`no grant with id ${id}`);
    this.name = "GrantNotFoundError";
  }
}

/** Store backend unreachable — callers must fail CLOSED. */
export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailableError";
  }
}

export interface TokenStore {
  /** touch=false checks validity without updating lastUsedAt (lobby verify). */
  verify(token: string, opts?: { touch?: boolean; kind?: TokenKind }): Promise<VerifyResult>;
  /** Returns the plaintext token exactly once; only its hash is stored. */
  mint(label: string, kind?: TokenKind): Promise<{ token: string; grant: Grant }>;
  /** Single-use burn of an active signup token; wrong kind or already-used → ok:false. */
  redeem(token: string): Promise<VerifyResult>;
  list(): Promise<Grant[]>;
  listEvents(tokenId: string): Promise<TokenEvent[]>;
  relabel(id: string, label: string): Promise<Grant>;
  revoke(id: string): Promise<Grant>;
  restore(id: string): Promise<Grant>;
  purge(id: string): Promise<void>;
}
