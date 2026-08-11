import type { NextConfig } from "next";

// Security headers. Targets a securityheaders.com "A" once live.
//
// CSP is derived from the app's REAL runtime needs (not guessed):
//   - script-src 'unsafe-inline': App Router streams the RSC payload via inline
//     <script> tags (self.__next_f.push(...)) and inline bootstrap. This app sets
//     the CSP in next.config (static generation preserved) rather than via a
//     per-request nonce in proxy.ts — the nonce path forces every page to
//     dynamic rendering (docs/01-app/02-guides/content-security-policy.md:385),
//     which we deliberately avoid the night before the dress rehearsal. No
//     'unsafe-eval' in prod: no client WebAssembly, no eval; the E2EE worker is
//     a bundled ES module (lib/webrtc/e2ee.worker.ts).
//   - style-src 'unsafe-inline': next/font/google injects inline @font-face
//     <style>, plus React inline style={{}} attributes (e.g. VideoTile,
//     RecordingRow).
//   - img-src data: — the SVG seal is a data:image/svg+xml url() in
//     app/globals.css; blob: — waveform.png is fetched then rendered via
//     URL.createObjectURL (components/RecordingRow.tsx).
//   - font-src 'self': next/font/google self-hosts woff2 under /_next/static/media.
//   - media-src blob:: recorded audio/video plays back from
//     URL.createObjectURL blobs (RecordingRow <audio>, take/episode playback);
//     MediaRecorder output (lib/podcast/recorder.ts). Live tiles use srcObject
//     MediaStream, which CSP does not gate.
//   - worker-src 'self' blob:: E2EE worker via
//     new Worker(new URL("./e2ee.worker.ts", import.meta.url)) (lib/webrtc/peer.ts)
//     — Next serves it same-origin; blob: is defensive for bundler-wrapped workers.
//   - connect-src: same-origin RSC + the trusted-postman API over https and the
//     signaling WebSocket over wss (lib/config.ts → NEXT_PUBLIC_API_URL /
//     NEXT_PUBLIC_SIGNALING_URL = api.coneofsilence.app). No Supabase origin:
//     the client never talks to Supabase directly — only the server does. STUN/
//     TURN are intentionally omitted: current Chrome/Firefox do NOT gate WebRTC
//     ICE/STUN/TURN transport via connect-src (it is not a fetch). If a future
//     browser starts enforcing it, add: stun.l.google.com turn.coneofsilence.app.
//
// Next 16 headers API: async headers() with { source, headers: [{key,value}] }
// (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md).

const isDev = process.env.NODE_ENV === "development";

const API_ORIGIN = "https://api.coneofsilence.app";
const SIGNALING_ORIGIN = "wss://api.coneofsilence.app";

const connectSrc = [
  "'self'",
  API_ORIGIN,
  SIGNALING_ORIGIN,
  // Dev only: HMR websocket + local droplet defaults (http/ws://localhost:8787).
  ...(isDev ? ["http://localhost:*", "ws://localhost:*"] : []),
].join(" ");

// 'unsafe-eval' in dev only — React uses eval for enhanced error overlays in
// development; it is not used in production
// (docs/01-app/02-guides/content-security-policy.md:42).
const scriptSrc = `'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`;

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src ${connectSrc}`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // .app is HSTS-preloaded at the TLD level; the explicit header ensures the
  // securityheaders.com scanner sees it and covers non-preload-aware clients.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Superseded by CSP frame-ancestors 'none'; kept for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  // camera/microphone to self (the whole point of the app); display-capture to
  // self for in-call screen sharing (getDisplayMedia); autoplay + fullscreen
  // to self so live tiles play and native media controls work; everything else off.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=(self)",
      "browsing-topics=()",
      "camera=(self)",
      "display-capture=(self)",
      "encrypted-media=()",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=(self)",
      "midi=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
