import { Router, type Request, type Response } from "express";
import { GrantNotFoundError, type TokenStore } from "../tokens/types.js";
import { createRun } from "./run.js";
import { hasExactKeys, parseKind, parseLabel } from "./validate.js";

export function createAdminRouter(store: TokenStore): Router {
  const router = Router();

  // Anything that isn't a missing grant fails CLOSED with a logged 503.
  const run = createRun("[admin]", (err) =>
    err instanceof GrantNotFoundError ? { status: 404, error: "not found" } : null,
  );

  router.get("/tokens", (_req: Request, res: Response) =>
    run(res, async () => {
      res.json({ grants: await store.list() });
    }),
  );

  router.post("/tokens", (req: Request, res: Response) =>
    run(res, async () => {
      const body = req.body as Record<string, unknown>;
      const withKind = hasExactKeys(body, ["label", "kind"]);
      if (!withKind && !hasExactKeys(body, ["label"])) {
        res.status(400).json({ error: "body must be { label } or { label, kind }" });
        return;
      }
      const label = parseLabel(body.label);
      if (!label) {
        res.status(400).json({ error: "label must be 1-64 printable characters" });
        return;
      }
      const kind = withKind ? parseKind(body.kind) : "room-creation";
      if (!kind) {
        res.status(400).json({ error: "kind must be room-creation or signup" });
        return;
      }
      const { token, grant } = await store.mint(label, kind);
      res.status(201).json({ token, grant });
    }),
  );

  router.patch("/tokens/:id", (req: Request, res: Response) =>
    run(res, async () => {
      const id = req.params.id as string;
      const body = req.body as Record<string, unknown>;
      if (hasExactKeys(body, ["label"])) {
        const label = parseLabel(body.label);
        if (!label) {
          res.status(400).json({ error: "label must be 1-64 printable characters" });
          return;
        }
        res.json({ grant: await store.relabel(id, label) });
        return;
      }
      if (hasExactKeys(body, ["revoked"]) && typeof body.revoked === "boolean") {
        const grant = body.revoked ? await store.revoke(id) : await store.restore(id);
        res.json({ grant });
        return;
      }
      res.status(400).json({ error: "body must be exactly { label } or { revoked }" });
    }),
  );

  router.delete("/tokens/:id", (req: Request, res: Response) =>
    run(res, async () => {
      await store.purge(req.params.id as string);
      res.status(204).end();
    }),
  );

  return router;
}
