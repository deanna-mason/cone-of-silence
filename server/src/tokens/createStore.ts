import { createSupabaseClient } from "../supabaseClient.js";
import { FileTokenStore } from "./fileStore.js";
import { SupabaseTokenStore } from "./supabaseStore.js";
import type { TokenStore } from "./types.js";

export async function createStore(env: NodeJS.ProcessEnv): Promise<TokenStore> {
  const kind = env.TOKEN_STORE ?? "file";
  if (kind === "file") {
    return FileTokenStore.open(env.TOKEN_FILE ?? "data/tokens.json");
  }
  if (kind === "supabase") {
    try {
      return new SupabaseTokenStore(createSupabaseClient(env));
    } catch {
      throw new Error("TOKEN_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
  }
  throw new Error(`unknown TOKEN_STORE: ${kind}`);
}
