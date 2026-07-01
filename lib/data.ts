export type Priority = "must-have" | "stretch";

export interface Idea {
  id: string;
  category: string;
  title: string;
  notes: string;
  priority: Priority;
}

export const ideas: Idea[] = [
  {
    id: "webrtc-p2p",
    category: "Core WebRTC / signaling",
    title: "Peer-to-peer video via WebRTC",
    notes:
      "Two people in a call directly connected. When a third joins, they connect to both existing peers (full mesh for small calls).",
    priority: "must-have",
  },
  {
    id: "signaling-server",
    category: "Core WebRTC / signaling",
    title: "WebSocket signaling backend",
    notes:
      "A small backend to facilitate the WebRTC handshake: manages who sends offers/answers/ICE candidates to whom. Bounce through the server for reliability; server never sees media.",
    priority: "must-have",
  },
  {
    id: "opt-in-encryption",
    category: "Encryption layer",
    title: "Opt-in extra end-to-end encryption",
    notes:
      "Decoupled from the base app. When coordinating with the server, users opt in. Client-authoritative: key generation and key sharing happen only on the client.",
    priority: "stretch",
  },
  {
    id: "key-exchange",
    category: "Encryption layer",
    title: "Public-key exchange over the data channel",
    notes:
      "Send public keys through the WebRTC connection (not the signaling socket) so the server never learns them. Sender encrypts, recipient decrypts. Only I hold the keys — Signal/Telegram-style.",
    priority: "stretch",
  },
  {
    id: "dual-face-record",
    category: "Podcast recording mode",
    title: "Dual-face recording",
    notes:
      "Record a podcast with a co-host over video. Keep both faces on screen the entire time for the recording.",
    priority: "must-have",
  },
  {
    id: "separate-audio-tracks",
    category: "Podcast recording mode",
    title: "Separate audio tracks per speaker",
    notes:
      "Capture each participant's audio on its own track so they can be edited independently in post.",
    priority: "must-have",
  },
  {
    id: "auto-postprod",
    category: "Post-production",
    title: "Simple post-production pipeline",
    notes:
      "Touch up video and audio automatically, then format/output everything into a folder ready for the final Final Cut Pro pass. Keep it dead simple.",
    priority: "stretch",
  },
];
