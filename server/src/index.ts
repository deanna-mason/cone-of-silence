import { createServer } from "node:http";
import ws from "ws";
import { createClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";
import { createApp } from "./http/app.js";
import { SupabaseRecordingStore } from "./studio/supabaseRecordings.js";
import { createStore } from "./tokens/createStore.js";
import { attachSignaling } from "./ws/attach.js";
import { SupabaseAccountStore } from "./accounts/supabaseAccounts.js";

const adminSecret = process.env.ADMIN_SECRET ?? "";
if (adminSecret.length < 16) {
  console.error("ADMIN_SECRET env var required (16+ chars). Refusing to start.");
  process.exit(1);
}

// Interim wiring — Task 8 will fold this into a shared factory alongside createStore.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error("accounts require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
  realtime: { transport: ws as WebSocketLikeConstructor },
});
const accounts = new SupabaseAccountStore(supabase);
const recordings = new SupabaseRecordingStore(supabase);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const port = Number(process.env.PORT ?? 8787);
const uploadDir = process.env.UPLOAD_DIR ?? "data/uploads";
// Task 7 replaces this with the JobRunner
const runner = { kick() {} };

const store = await createStore(process.env);
const app = createApp({ store, accounts, adminSecret, allowedOrigins, recordings, uploadDir, runner });
const httpServer = createServer(app);
attachSignaling(httpServer, { store, allowedOrigins });
httpServer.listen(port, () => {
  console.log(`cone-of-silence server (http + ws) listening on :${port}`);
});
