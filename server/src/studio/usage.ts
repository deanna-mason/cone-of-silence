import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Total bytes on disk under dir (recursive). Missing dir = 0 (user has never
 *  uploaded). Any other fs error propagates so callers fail CLOSED. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath, entry.name)).catch(() => null);
    if (s) total += s.size;
  }
  return total;
}
