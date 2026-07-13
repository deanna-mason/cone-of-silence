import type { NextFunction, Request, Response } from "express";

/** Hand-rolled (zero-dep) origin allowlist — mirrors the ws Origin check planned for Phase 2. */
export function createCors(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get("origin");
    res.set("Vary", "Origin");
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
