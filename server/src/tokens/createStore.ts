import { FileTokenStore } from "./fileStore.js";
import type { TokenStore } from "./types.js";

/** Select the backing store from env. Supabase branch lands in Task 8. */
export async function createStore(env: NodeJS.ProcessEnv): Promise<TokenStore> {
  const kind = env.TOKEN_STORE ?? "file";
  if (kind === "file") {
    return FileTokenStore.open(env.TOKEN_FILE ?? "data/tokens.json");
  }
  throw new Error(`unknown TOKEN_STORE: ${kind}`);
}
