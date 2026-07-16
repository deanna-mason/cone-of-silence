import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { SessionInfo } from "../accounts/types.js";
import type { RecordingStore } from "../studio/types.js";
import {
  ALLOWED_EXTS,
  ENHANCED_NAME,
  MAX_UPLOAD_BYTES,
  recordingDir,
  sourcePath,
  USER_QUOTA_BYTES,
  WAVEFORM_NAME,
} from "../studio/paths.js";
import { dirSizeBytes } from "../studio/usage.js";

export interface StudioDeps {
  uploadDir: string;
  runner: { kick(): void };
  userQuotaBytes?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createStudioRouter(store: RecordingStore, deps: StudioDeps): Router {
  const router = Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: join(deps.uploadDir, "tmp"),
      filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      cb(null, ALLOWED_EXTS.has(extname(file.originalname).toLowerCase()));
    },
  });

  const run = async (res: Response, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error("[studio]", err); // fail closed, but don't swallow the cause
      res.status(503).json({ error: "channel unavailable" });
    }
  };

  const sessionOf = (res: Response): SessionInfo => res.locals.session as SessionInfo;

  router.post("/recordings", async (req: Request, res: Response) => {
    await mkdir(join(deps.uploadDir, "tmp"), { recursive: true });
    upload.single("file")(req, res, (err: unknown) =>
      run(res, async () => {
        if (err) {
          const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
          res.status(tooBig ? 413 : 400).json({ error: tooBig ? "max 1 GiB" : "upload failed" });
          return;
        }
        if (!req.file) {
          res.status(400).json({ error: "file must be one of: mp3 m4a wav aac flac ogg webm mp4 mov mkv" });
          return;
        }
        const ext = extname(req.file.originalname).toLowerCase();
        const name = req.file.originalname.slice(0, 200);
        try {
          const quota = deps.userQuotaBytes ?? USER_QUOTA_BYTES;
          const used = await dirSizeBytes(join(deps.uploadDir, sessionOf(res).userId));
          if (used + req.file.size > quota) {
            await unlink(req.file.path).catch(() => {});
            res.status(507).json({ error: "storage full — burn old recordings to free space" });
            return;
          }
          const rec = await store.create(sessionOf(res).userId, name, ext);
          const dir = recordingDir(deps.uploadDir, rec.userId, rec.id);
          await mkdir(dir, { recursive: true });
          await rename(req.file.path, sourcePath(dir, ext));
          deps.runner.kick();
          res.status(201).json({ recording: rec });
        } catch (e) {
          await unlink(req.file.path).catch(() => {});
          throw e;
        }
      }),
    );
  });

  router.get("/recordings", (_req: Request, res: Response) =>
    run(res, async () => {
      res.json({ recordings: await store.listByUser(sessionOf(res).userId) });
    }),
  );

  /** Load + ownership check; null ⇒ 404 already sent. */
  const owned = async (req: Request, res: Response) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    const rec = await store.get(id);
    if (!rec || rec.userId !== sessionOf(res).userId) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return rec;
  };

  router.get("/recordings/:id", (req: Request, res: Response) =>
    run(res, async () => {
      const rec = await owned(req, res);
      if (rec) res.json({ recording: rec });
    }),
  );

  const serveArtifact = (name: string) => (req: Request, res: Response) =>
    run(res, async () => {
      const rec = await owned(req, res);
      if (!rec) return;
      if (rec.status !== "done") {
        res.status(404).json({ error: "not ready" });
        return;
      }
      res.sendFile(name, { root: recordingDir(deps.uploadDir, rec.userId, rec.id) });
    });

  router.get(`/recordings/:id/${ENHANCED_NAME}`, serveArtifact(ENHANCED_NAME));
  router.get(`/recordings/:id/${WAVEFORM_NAME}`, serveArtifact(WAVEFORM_NAME));

  router.delete("/recordings/:id", (req: Request, res: Response) =>
    run(res, async () => {
      const rec = await owned(req, res);
      if (!rec) return;
      await rm(recordingDir(deps.uploadDir, rec.userId, rec.id), { recursive: true, force: true });
      await store.remove(rec.id);
      res.status(204).end();
    }),
  );

  return router;
}
