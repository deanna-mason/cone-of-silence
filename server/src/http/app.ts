import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AccountStore } from "../accounts/types.js";
import type { TokenStore } from "../tokens/types.js";
import { createAdminAuth } from "./auth.js";
import { createAdminRouter } from "./adminRoutes.js";
import { createAuthRouter } from "./authRoutes.js";
import { createCors } from "./cors.js";
import { createVerifyRouter } from "./verifyRoutes.js";

export interface AppOptions {
  store: TokenStore;
  accounts: AccountStore;
  adminSecret: string;
  allowedOrigins: string[];
}

export function createApp({ store, accounts, adminSecret, allowedOrigins }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(createCors(allowedOrigins));
  app.use(express.json());

  app.use(createVerifyRouter(store));
  app.use("/admin", createAdminAuth(adminSecret), createAdminRouter(store));
  app.use("/auth", createAuthRouter(accounts, store));

  // malformed JSON body → 400, everything else → fail closed
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid JSON" });
      return;
    }
    res.status(503).json({ error: "channel unavailable" });
  });

  return app;
}
