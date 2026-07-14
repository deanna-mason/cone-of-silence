// Adapts real `ws` sockets to the SignalingHandler: Origin-checked upgrades
// on /ws, protocol-level ping heartbeat (browsers answer pings natively),
// and the empty-room grace sweep on the same timer.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { TokenStore } from "../tokens/types.js";
import { SignalingHandler } from "./handler.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH = "/ws";
const MAX_FRAME_BYTES = 128 * 1024; // ws rejects larger frames outright

export interface Signaling {
  handler: SignalingHandler;
  wss: WebSocketServer;
  stop(): void;
}

type TrackedSocket = WebSocket & { isAlive?: boolean };

export function attachSignaling(
  httpServer: Server,
  opts: { store: TokenStore; allowedOrigins: string[] },
): Signaling {
  const handler = new SignalingHandler(opts.store);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
      const origin = req.headers.origin;
      // Browsers always send Origin on WebSocket upgrades and scripts can't
      // forge it — fail closed on anything else.
      if (pathname !== WS_PATH || !origin || !opts.allowedOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: TrackedSocket) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (data) => {
      void handler.onMessage(ws, data.toString());
    });
    ws.on("close", () => handler.onClose(ws));
    // ECONNRESET etc. — without a listener Node re-throws and kills the process;
    // the paired "close" event runs the normal leave path.
    ws.on("error", () => {});
  });

  const timer = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as TrackedSocket;
      if (ws.isAlive === false) {
        ws.terminate(); // fires "close" → the normal leave path
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    handler.sweep();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return {
    handler,
    wss,
    stop() {
      clearInterval(timer);
      wss.close();
    },
  };
}
