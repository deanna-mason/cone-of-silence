// Pin the server's own config so vitest doesn't walk up and adopt the repo
// root's jsdom/front-end config.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
