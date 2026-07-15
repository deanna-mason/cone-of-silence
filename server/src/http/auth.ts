import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Lockout } from "./lockout.js";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

/** Length-independent constant-time comparison via digest equalization. */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function createAdminAuth(secret: string) {
  const lockout = new Lockout(MAX_FAILURES, LOCKOUT_MS);

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? "unknown";
    if (lockout.isLocked(ip)) {
      res.status(429).json({ error: "too many attempts" });
      return;
    }
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !secretsMatch(presented, secret)) {
      lockout.recordFailure(ip);
      // deliberately generic — reveal nothing about why
      res.status(401).json({ error: "denied" });
      return;
    }
    lockout.clear(ip);
    next();
  };
}
