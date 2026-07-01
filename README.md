# 🕵️ Cone of Silence

A two-page Next.js app styled like a 1960s spy title sequence. It previews my
final-project idea — a private, end-to-end encrypted video-calling app — through a
mock **Lobby** and a **Mission Dossier** that lays out the features I want to build.

**Live site:** https://cone-of-silence.vercel.app/
**Repository:** https://github.com/deanna-mason/cone-of-silence

Built for Assignment 1 to demonstrate components, props, state, list rendering,
conditional rendering, file-based routing, and deployment.

## Pages

- **`/` — Lobby:** a mock pre-call screen with a room-code field, a "Signal
  Scrambler" encryption toggle (show/hide explainer), and an "Initiate Contact"
  button that routes to the dossier.
- **`/brainstorm` — Mission Dossier:** the real feature plan as a redacted case
  file. Filter by All / Priority / Optional and tap any file to "declassify" its
  notes.

## Requirements demonstrated

| Requirement | Where |
| --- | --- |
| ≥ 3 components | `NavBar`, `RoomControls`, `EncryptionToggle`, `IdeaCard` |
| `useState` | Lobby (`roomCode`, `encryptionOn`), Dossier (`expandedId`, `filter`) |
| Passing props | every child component |
| Event-handler prop | `onToggle`, `onRoomCodeChange`, `onSelect` |
| List rendering with `.map()` + `key` | dossier ideas + filter tabs |
| Conditional rendering from state | encryption panel, declassified notes, filters |
| ≥ 2 pages via file-based routing | `/` and `/brainstorm` |
| `next/link` navigation | `NavBar` + "Initiate Contact" button |

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com)
- Fonts: Bebas Neue, Special Elite, Spectral (via `next/font`)
- Deployed on [Vercel](https://vercel.com) — every push to `main` auto-redeploys

## Run locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Project structure

```
app/
  layout.tsx          # shared shell + NavBar + fonts
  page.tsx            # "/"           Lobby
  brainstorm/page.tsx # "/brainstorm" Mission Dossier
  globals.css         # theme, film grain, stamps, animations
components/
  NavBar.tsx  RoomControls.tsx  EncryptionToggle.tsx  IdeaCard.tsx
lib/
  data.ts             # typed brainstorm data
```
