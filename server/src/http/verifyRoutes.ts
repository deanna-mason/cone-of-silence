import { Router, type Request, type Response } from "express";
import type { TokenStore } from "../tokens/types.js";
import { Lockout } from "./lockout.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export function createVerifyRouter(store: TokenStore): Router {
  const router = Router();
  // IP-keyed lockout with /auth/login's thresholds and 429 body: this route is
  // unauthenticated by design, so without it the 22-char token space can be
  // hammered from one address at line rate.
  const failures = new Lockout(MAX_FAILURES, LOCKOUT_MS);

  // Unauthenticated by design: it only answers "is this token live?"
  // Token arrives in the BODY — never a URL, never server logs.
  router.post("/tokens/verify", async (req: Request, res: Response) => {
    const key = req.ip ?? "unknown";
    if (failures.isLocked(key)) {
      res.status(429).json({ error: "too many attempts" });
      return;
    }
    const token = (req.body as Record<string, unknown> | undefined)?.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      failures.recordFailure(key);
      res.json({ valid: false, reason: "invalid" });
      return;
    }
    try {
      const result = await store.verify(token, { touch: false });
      if (result.ok) {
        failures.clear(key);
        res.json({ valid: true, label: result.grant.label });
      } else {
        failures.recordFailure(key);
        res.json({ valid: false, reason: result.reason });
      }
    } catch {
      // A store outage isn't a credential failure — don't let it count toward
      // (or leak through) the lockout.
      res.status(503).json({ error: "channel unavailable" }); // fail closed
    }
  });

  return router;
}
