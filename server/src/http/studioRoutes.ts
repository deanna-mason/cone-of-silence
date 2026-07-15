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
  WAVEFORM_NAME,
} from "../studio/paths.js";

export interface StudioDeps {
  uploadDir: string;
  runner: { kick(): void };
}

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
    } catch {
      res.status(503).json({ error: "channel unavailable" }); // fail closed
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
    const rec = await store.get(req.params.id as string);
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
