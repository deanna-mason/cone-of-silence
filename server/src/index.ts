import { createApp } from "./http/app.js";
import { createStore } from "./tokens/createStore.js";

const adminSecret = process.env.ADMIN_SECRET ?? "";
if (adminSecret.length < 16) {
  console.error("ADMIN_SECRET env var required (16+ chars). Refusing to start.");
  process.exit(1);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const port = Number(process.env.PORT ?? 8787);

const store = await createStore(process.env);
const app = createApp({ store, adminSecret, allowedOrigins });
app.listen(port, () => {
  console.log(`cone-of-silence server listening on :${port}`);
});
