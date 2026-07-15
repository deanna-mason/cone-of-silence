import type { NextFunction, Request, Response } from "express";
import type { AccountStore } from "../accounts/types.js";
import { hashToken } from "../tokens/crypto.js";
import { StoreUnavailableError } from "../tokens/types.js";

/** Bearer-session gate. On success res.locals.session is a SessionInfo. */
export function createUserAuth(accounts: AccountStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented) {
      res.status(401).json({ error: "denied" });
      return;
    }
    try {
      const session = await accounts.getSession(hashToken(presented));
      if (!session) {
        res.status(401).json({ error: "denied" });
        return;
      }
      res.locals.session = session;
      next();
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        res.status(503).json({ error: "channel unavailable" });
        return;
      }
      throw err;
    }
  };
}
