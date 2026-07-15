import ws from "ws";
import { createClient, type SupabaseClient, type WebSocketLikeConstructor } from "@supabase/supabase-js";

/**
 * Shared Supabase client factory. Throws a clear error when the required env
 * vars are missing so callers can fail fast at boot instead of crashing deep
 * inside a request handler.
 */
export function createSupabaseClient(env: NodeJS.ProcessEnv): SupabaseClient {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    // Node 20 lacks native WebSocket; supabase-js's constructor requires one even though this store never uses realtime. Remove when the runtime is Node >= 22.
    realtime: { transport: ws as WebSocketLikeConstructor },
  });
}
