// Frontend unit tests (jsdom + Testing Library), per the bundled Next.js
// vitest guide. Server tests live in server/ with their own vitest config.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.{ts,tsx}"],
  },
});
