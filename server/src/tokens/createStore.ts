import ws from "ws";
import { createClient } from "@supabase/supabase-js";
import { FileTokenStore } from "./fileStore.js";
import { SupabaseTokenStore } from "./supabaseStore.js";
import type { TokenStore } from "./types.js";

export async function createStore(env: NodeJS.ProcessEnv): Promise<TokenStore> {
  const kind = env.TOKEN_STORE ?? "file";
  if (kind === "file") {
    return FileTokenStore.open(env.TOKEN_FILE ?? "data/tokens.json");
  }
  if (kind === "supabase") {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("TOKEN_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    return new SupabaseTokenStore(createClient(url, key, { 
      auth: { persistSession: false },
      realtime: { transport: ws as any }
    }));
  }
  throw new Error(`unknown TOKEN_STORE: ${kind}`);
}
