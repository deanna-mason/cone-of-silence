import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { TokenStore } from "../tokens/types.js";
import { createAdminAuth } from "./auth.js";
import { createCors } from "./cors.js";

export interface AppOptions {
  store: TokenStore;
  adminSecret: string;
  allowedOrigins: string[];
}

export function createApp({ store, adminSecret, allowedOrigins }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(createCors(allowedOrigins));
  app.use(express.json());

  const admin = express.Router();
  admin.use(createAdminAuth(adminSecret));
  admin.get("/tokens", async (_req: Request, res: Response) => {
    res.json({ grants: await store.list() });
  });
  app.use("/admin", admin);

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
