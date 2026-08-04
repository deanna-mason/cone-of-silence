import type { Response } from "express";

/** An error a router maps to its own status instead of the generic 503. */
export interface MappedError {
  status: number;
  error: string;
}

/**
 * Builds a router's async error boundary. Anything the router's `classify`
 * doesn't claim is logged under `tag` and fails CLOSED with a generic 503 —
 * logging is not optional, an unexplained outage is an invisible one.
 */
export function createRun(
  tag: string,
  classify: (err: unknown) => MappedError | null = () => null,
) {
  return async (res: Response, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const mapped = classify(err);
      if (mapped) {
        res.status(mapped.status).json({ error: mapped.error });
        return;
      }
      console.error(tag, err); // fail closed, but don't swallow the cause
      res.status(503).json({ error: "channel unavailable" });
    }
  };
}
