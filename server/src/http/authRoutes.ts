import { Router, type Request, type Response } from "express";
import {
  generateSessionToken,
  hashPassword,
  SESSION_TTL_MS,
  USERNAME_RE,
  verifyPassword,
} from "../accounts/crypto.js";
import { UsernameTakenError, type AccountStore } from "../accounts/types.js";
import { hashToken } from "../tokens/crypto.js";
import type { TokenStore } from "../tokens/types.js";
import { hasExactKeys } from "./validate.js";
import { Lockout } from "./lockout.js";
import { createUserAuth } from "./userAuth.js";

const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

// Burned on every login attempt for an unknown username so the bcrypt
// compare always runs — otherwise a missing account short-circuits the
// verify call and the timing difference leaks which usernames exist.
const DUMMY_HASH = await hashPassword("cone-of-silence-dummy");

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 72;
}

async function issueSession(accounts: AccountStore, userId: string) {
  const session = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await accounts.createSession(userId, hashToken(session), expiresAt);
  return { session, expiresAt };
}

export function createAuthRouter(accounts: AccountStore, tokens: TokenStore): Router {
  const router = Router();
  const failures = new Lockout(MAX_FAILURES, LOCKOUT_MS);

  const run = async (res: Response, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error("[auth]", err); // fail closed, but don't swallow the cause
      res.status(503).json({ error: "channel unavailable" });
    }
  };

  router.post("/signup", (req: Request, res: Response) =>
    run(res, async () => {
      const body = req.body as Record<string, unknown>;
      if (!hasExactKeys(body, ["token", "username", "password"])) {
        res.status(400).json({ error: "body must be exactly { token, username, password }" });
        return;
      }
      const { token, username, password } = body;
      if (typeof token !== "string" || !TOKEN_RE.test(token)) {
        res.status(400).json({ error: "malformed token" });
        return;
      }
      if (typeof username !== "string" || !USERNAME_RE.test(username)) {
        res.status(400).json({ error: "username: 3-20 chars, a-z 0-9 _" });
        return;
      }
      if (!validPassword(password)) {
        res.status(400).json({ error: "password: 8-72 characters" });
        return;
      }
      // Peek before burning so a taken username doesn't waste the token.
      const peek = await tokens.verify(token, { touch: false, kind: "signup" });
      if (!peek.ok) {
        res.status(401).json({ error: "denied" });
        return;
      }
      if (await accounts.getCredentials(username)) {
        res.status(409).json({ error: "codename taken" });
        return;
      }
      const burned = await tokens.redeem(token);
      if (!burned.ok) {
        res.status(401).json({ error: "denied" }); // lost a race
        return;
      }
      let userId: string;
      try {
        const user = await accounts.createUser(username, await hashPassword(password));
        userId = user.id;
      } catch (err) {
        if (err instanceof UsernameTakenError) {
          await tokens.restore(burned.grant.id); // compensate: give the token back
          res.status(409).json({ error: "codename taken" });
          return;
        }
        throw err;
      }
      const { session, expiresAt } = await issueSession(accounts, userId);
      res.status(201).json({ session, username, expiresAt });
    }),
  );

  router.post("/login", (req: Request, res: Response) =>
    run(res, async () => {
      const body = req.body as Record<string, unknown>;
      if (
        !hasExactKeys(body, ["username", "password"]) ||
        typeof body.username !== "string" ||
        typeof body.password !== "string" ||
        // A username longer than USERNAME_RE's max can't be a real account —
        // reject it before it's ever used as a lockout-map key.
        body.username.length > 20
      ) {
        res.status(400).json({ error: "body must be exactly { username, password }" });
        return;
      }
      const key = `${req.ip ?? "unknown"}:${body.username}`;
      if (failures.isLocked(key)) {
        res.status(429).json({ error: "too many attempts" });
        return;
      }
      const creds = await accounts.getCredentials(body.username);
      // Always run the bcrypt compare — against the real hash if the
      // username exists, otherwise against a fixed dummy hash — so a
      // missing account isn't measurably faster than a wrong password.
      const passwordOk = creds
        ? await verifyPassword(body.password, creds.passwordHash)
        : await verifyPassword(body.password, DUMMY_HASH);
      const ok = creds !== null && passwordOk;
      if (!ok) {
        failures.recordFailure(key);
        res.status(401).json({ error: "denied" }); // deliberately generic
        return;
      }
      failures.clear(key);
      const { session, expiresAt } = await issueSession(accounts, creds.user.id);
      res.json({ session, username: creds.user.username, expiresAt });
    }),
  );

  const requireUser = createUserAuth(accounts);

  router.post("/logout", requireUser, (req: Request, res: Response) =>
    run(res, async () => {
      const header = req.get("authorization") ?? "";
      await accounts.deleteSession(hashToken(header.slice(7)));
      res.status(204).end();
    }),
  );

  router.get("/me", requireUser, (_req: Request, res: Response) => {
    res.json({ username: (res.locals.session as { username: string }).username });
  });

  return router;
}
