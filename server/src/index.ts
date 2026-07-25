import { createServer } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./http/app.js";
import { JobRunner } from "./studio/runner.js";
import { SupabaseRecordingStore } from "./studio/supabaseRecordings.js";
import { createSupabaseClient } from "./supabaseClient.js";
import { createStore } from "./tokens/createStore.js";
import { iceServers, turnConfigFromEnv } from "./turn/creds.js";
import { attachSignaling } from "./ws/attach.js";
import { SupabaseAccountStore } from "./accounts/supabaseAccounts.js";

const adminSecret = process.env.ADMIN_SECRET ?? "";
if (adminSecret.length < 16) {
  console.error("ADMIN_SECRET env var required (16+ chars). Refusing to start.");
  process.exit(1);
}

// Accounts + Studio require Supabase even when TOKEN_STORE=file.
let supabase: SupabaseClient;
try {
  supabase = createSupabaseClient(process.env);
} catch (err) {
  console.error("accounts require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:", (err as Error).message);
  process.exit(1);
}
const accounts = new SupabaseAccountStore(supabase);
const recordings = new SupabaseRecordingStore(supabase);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let turnCfg;
try {
  turnCfg = turnConfigFromEnv(process.env);
} catch (err) {
  console.error("TURN misconfigured:", (err as Error).message, "— refusing to start.");
  process.exit(1);
}
console.log(
  turnCfg ? `TURN relay configured: ${turnCfg.urls.join(", ")}` : "TURN not configured — STUN only",
);

const port = Number(process.env.PORT ?? 8787);
const uploadDir = process.env.UPLOAD_DIR ?? "data/uploads";
const runner = new JobRunner(recordings, {
  uploadDir,
  rnnoiseModel: process.env.RNNOISE_MODEL ?? "models/std.rnnn",
});

const store = await createStore(process.env);
const app = createApp({ store, accounts, adminSecret, allowedOrigins, recordings, uploadDir, runner });
const httpServer = createServer(app);
attachSignaling(httpServer, {
  store,
  allowedOrigins,
  iceServers: () => iceServers(turnCfg, Date.now()),
});
httpServer.listen(port, () => {
  console.log(`cone-of-silence server (http + ws) listening on :${port}`);
});
// Recover any rows left "processing" by a previous crash, then start draining the
// queue. Runs after listen() so a slow recover/first-job never delays health checks.
runner.recoverAndKick().catch((err) => console.error("recoverAndKick failed:", err));
