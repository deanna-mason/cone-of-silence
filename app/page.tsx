"use client";

import { useEffect, useState } from "react";
import RoomControls from "@/components/RoomControls";
import ClearanceBadge, { type Clearance } from "@/components/ClearanceBadge";
import {
  burnCreateToken,
  parseCreateHash,
  readCreateToken,
  storeCreateToken,
  verifyCreateToken,
} from "@/lib/createToken";

export default function LobbyPage() {
  const [clearance, setClearance] = useState<Clearance>({ state: "none" });

  useEffect(() => {
    const incoming = parseCreateHash(window.location.hash);
    if (incoming) {
      // Store first (server enforces on create anyway), then confirm live.
      storeCreateToken(incoming);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setClearance({ state: "active" });
      void verifyCreateToken(incoming).then((status) => {
        if (status === "accepted") setClearance({ state: "accepted" });
        if (status === "unreachable") setClearance({ state: "unreachable" });
        if (status === "inactive") {
          burnCreateToken();
          setClearance({ state: "inactive" });
        }
      });
      return;
    }
    const stored = readCreateToken();
    if (stored) {
      // Show clearance immediately (no flicker), then re-verify in the
      // background — a stashed token could have been revoked since.
      setClearance({ state: "active" });
      void verifyCreateToken(stored).then((status) => {
        if (status === "inactive") {
          burnCreateToken();
          setClearance({ state: "inactive" });
        }
        if (status === "unreachable") setClearance({ state: "unreachable" });
        // "accepted" leaves clearance as "active" — already showing.
      });
    }
  }, []);

  function handleBurn() {
    burnCreateToken();
    setClearance({ state: "none" });
  }

  const canCreate = clearance.state !== "none" && clearance.state !== "inactive";

  // 4A "Case-File Cover" (design CS-DR-04): the lobby IS the folder — a tabbed
  // manila cover on the deeper paper tone, typed dossier rows, a rotated
  // CLASSIFIED cover stamp, and a one-gesture join.
  return (
    <div className="rise mx-auto max-w-xl" style={{ animationDelay: "0.1s" }}>
      <div className="relative pt-6">
        {/* Folder tab */}
        <span className="hairline absolute left-6 top-0 border border-b-0 bg-field-deep px-3 py-1 font-type text-[0.6rem] uppercase tracking-[0.22em] text-ink-soft">
          Case CS-001 · Active
        </span>

        {/* Folder cover */}
        <section className="hairline relative overflow-hidden border bg-field-deep p-6 sm:p-8">
          {/* Rotated cover stamp */}
          <span
            aria-hidden
            className="stamp pointer-events-none absolute right-4 top-8 -rotate-6 text-vermilion opacity-80"
          >
            CLASSIFIED
          </span>

          <p className="kicker text-sienna">◈ Central Registry</p>
          <h1 className="mt-3 font-display text-5xl uppercase leading-[0.9] tracking-[0.04em] text-ink sm:text-6xl">
            Cone of
            <br />
            <span className="text-vermilion">Silence</span>
          </h1>

          {/* Typed dossier rows — each a real fact. Clearance is the badge. */}
          <dl className="mt-7 font-type text-[0.68rem] uppercase tracking-[0.1em] text-ink-soft">
            <div className="flex items-center justify-between gap-4 border-b border-dotted border-ink-faint/45 py-2">
              <dt>Subject</dt>
              <dd className="text-right text-ink">Encrypted line, four seats</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-dotted border-ink-faint/45 py-2">
              <dt>Retention</dt>
              <dd className="text-right">
                {/* 4C flourish: hover to declassify */}
                <span
                  title="Hover to declassify"
                  className="cursor-help bg-ink px-1 text-transparent transition-colors hover:bg-transparent hover:text-vermilion"
                >
                  None — burned on exit
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-dotted border-ink-faint/45 py-2">
              <dt>Clearance</dt>
              <dd className="text-right text-ink">
                <ClearanceBadge clearance={clearance} onBurn={handleBurn} />
              </dd>
            </div>
          </dl>

          <RoomControls canCreate={canCreate} />
        </section>
      </div>
    </div>
  );
}
