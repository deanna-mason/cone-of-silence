import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AccountStore } from "../accounts/types.js";
import type { RecordingStore } from "../studio/types.js";
import type { TokenStore } from "../tokens/types.js";
import { createAdminAuth } from "./auth.js";
import { createAdminRouter } from "./adminRoutes.js";
import { createAuthRouter } from "./authRoutes.js";
import { createCors } from "./cors.js";
import { createStudioRouter } from "./studioRoutes.js";
import { createUserAuth } from "./userAuth.js";
import { createVerifyRouter } from "./verifyRoutes.js";

export interface AppOptions {
  store: TokenStore;
  accounts: AccountStore;
  adminSecret: string;
  allowedOrigins: string[];
  recordings: RecordingStore;
  uploadDir: string;
  runner: { kick(): void };
  userQuotaBytes?: number;
}

export function createApp({
  store,
  accounts,
  adminSecret,
  allowedOrigins,
  recordings,
  uploadDir,
  runner,
  userQuotaBytes,
}: AppOptions): Express {
  const app = express();
  // Caddy fronts this app on the droplet, so req.socket.remoteAddress is
  // always 127.0.0.1 unless we trust the loopback proxy and read the real
  // client IP it sets in X-Forwarded-For. Without this, req.ip is constant
  // for every request and the IP-keyed rate limiters below key on nothing.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  app.use(createCors(allowedOrigins));
  app.use(express.json());

  app.use(createVerifyRouter(store));
  app.use("/admin", createAdminAuth(adminSecret), createAdminRouter(store));
  app.use("/auth", createAuthRouter(accounts, store));
  app.use("/studio", createUserAuth(accounts), createStudioRouter(recordings, { uploadDir, runner, userQuotaBytes }));

  // malformed JSON body → 400, everything else → fail closed
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }
    console.error("[app] unhandled error", err); // fail closed, but don't swallow the cause
    res.status(503).json({ error: "channel unavailable" });
  });

  return app;
}
