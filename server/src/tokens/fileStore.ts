import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generateToken, hashToken } from "./crypto.js";
import {
  Grant,
  GrantNotFoundError,
  StoreUnavailableError,
  TokenEvent,
  TokenEventKind,
  TokenStore,
  VerifyResult,
} from "./types.js";

interface StoredGrant extends Grant {
  tokenHash: string;
}

interface FileShape {
  grants: StoredGrant[];
  events: TokenEvent[];
}

function isFileShape(value: unknown): value is FileShape {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as FileShape).grants) &&
    Array.isArray((value as FileShape).events)
  );
}

/** JSON-file allowlist. Post-class default; also the networkless test double. */
export class FileTokenStore implements TokenStore {
  private constructor(
    private readonly path: string,
    private data: FileShape,
  ) {}

  static async open(path: string): Promise<FileTokenStore> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new FileTokenStore(path, { grants: [], events: [] });
      }
      throw new StoreUnavailableError(
        `failed to read token store at ${path}: ${(err as Error).message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StoreUnavailableError(
        `token store at ${path} contains invalid JSON: ${(err as Error).message}`,
      );
    }

    if (!isFileShape(parsed)) {
      throw new StoreUnavailableError(
        `token store at ${path} has an unexpected shape`,
      );
    }

    return new FileTokenStore(path, parsed);
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.path); // atomic — no torn files on crash
    } catch (err) {
      throw new StoreUnavailableError(
        `failed to write token store at ${this.path}: ${(err as Error).message}`,
      );
    }
  }

  private addEvent(
    tokenId: string,
    event: TokenEventKind,
    detail: Record<string, unknown> | null = null,
  ): void {
    this.data.events.push({
      id: randomUUID(),
      tokenId,
      event,
      occurredAt: new Date().toISOString(),
      detail,
    });
  }

  private mustFind(id: string): StoredGrant {
    const grant = this.data.grants.find((g) => g.id === id);
    if (!grant) throw new GrantNotFoundError(id);
    return grant;
  }

  private static toPublic({ tokenHash: _hash, ...grant }: StoredGrant): Grant {
    return grant;
  }

  async verify(token: string, opts?: { touch?: boolean }): Promise<VerifyResult> {
    const hash = hashToken(token);
    const grant = this.data.grants.find((g) => g.tokenHash === hash);
    if (!grant) return { ok: false, reason: "invalid" };
    if (grant.revokedAt) return { ok: false, reason: "revoked" };
    if (opts?.touch !== false) {
      grant.lastUsedAt = new Date().toISOString();
      await this.save();
    }
    return { ok: true, grant: FileTokenStore.toPublic(grant) };
  }

  async mint(label: string): Promise<{ token: string; grant: Grant }> {
    const token = generateToken();
    const grant: StoredGrant = {
      id: randomUUID(),
      label,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.data.grants.push(grant);
    this.addEvent(grant.id, "minted");
    await this.save();
    return { token, grant: FileTokenStore.toPublic(grant) };
  }

  async list(): Promise<Grant[]> {
    return this.data.grants.map(FileTokenStore.toPublic);
  }

  async listEvents(tokenId: string): Promise<TokenEvent[]> {
    return this.data.events.filter((e) => e.tokenId === tokenId);
  }

  async relabel(id: string, label: string): Promise<Grant> {
    const grant = this.mustFind(id);
    const from = grant.label;
    grant.label = label;
    this.addEvent(id, "relabeled", { from, to: label });
    await this.save();
    return FileTokenStore.toPublic(grant);
  }

  async revoke(id: string): Promise<Grant> {
    const grant = this.mustFind(id);
    grant.revokedAt = new Date().toISOString();
    this.addEvent(id, "revoked");
    await this.save();
    return FileTokenStore.toPublic(grant);
  }

  async restore(id: string): Promise<Grant> {
    const grant = this.mustFind(id);
    grant.revokedAt = null;
    this.addEvent(id, "restored");
    await this.save();
    return FileTokenStore.toPublic(grant);
  }

  async purge(id: string): Promise<void> {
    this.mustFind(id);
    this.data.grants = this.data.grants.filter((g) => g.id !== id);
    this.data.events = this.data.events.filter((e) => e.tokenId !== id);
    await this.save();
  }
}
