import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

/** Length-independent constant-time comparison via digest equalization. */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createAdminAuth(secret: string) {
  const failures = new Map<string, { count: number; lockedUntil: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "unknown";
    const record = failures.get(ip);
    if (record && record.lockedUntil > Date.now()) {
      res.status(429).json({ error: "too many attempts" });
      return;
    }
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !secretsMatch(presented, secret)) {
      const count = (record?.count ?? 0) + 1;
      failures.set(ip, {
        count,
        lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0,
      });
      // deliberately generic — reveal nothing about why
      res.status(401).json({ error: "denied" });
      return;
    }
    failures.delete(ip);
    next();
  };
}
