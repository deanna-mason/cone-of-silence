import { Router, type Request, type Response } from "express";
import type { TokenStore } from "../tokens/types.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function createVerifyRouter(store: TokenStore): Router {
  const router = Router();

  // Unauthenticated by design: it only answers "is this token live?"
  // Token arrives in the BODY — never a URL, never server logs.
  router.post("/tokens/verify", async (req: Request, res: Response) => {
    const token = (req.body as Record<string, unknown> | undefined)?.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      res.json({ valid: false, reason: "invalid" });
      return;
    }
    try {
      const result = await store.verify(token, { touch: false });
      if (result.ok) {
        res.json({ valid: true, label: result.grant.label });
      } else {
        res.json({ valid: false, reason: result.reason });
      }
    } catch {
      res.status(503).json({ error: "channel unavailable" }); // fail closed
    }
  });

  return router;
}
