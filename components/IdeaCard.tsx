"use client";

import type { Idea } from "@/lib/data";

interface IdeaCardProps {
  idea: Idea;
  expanded: boolean;
  onSelect: (id: string) => void;
}

export default function IdeaCard({ idea, expanded, onSelect }: IdeaCardProps) {
  const isPriority = idea.priority === "must-have";

  return (
    <li className="hairline border bg-panel/60">
      <button
        type="button"
        onClick={() => onSelect(idea.id)}
        className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition hover:bg-panel"
      >
        <span>
          <span className="kicker block text-brass">{idea.category}</span>
          <span className="mt-1 block font-display text-2xl leading-tight tracking-[0.03em] text-paper">
            {idea.title}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span
            className={`stamp rotate-[-3deg] text-[0.6rem] ${
              isPriority ? "text-vermilion" : "text-brass"
            }`}
          >
            {isPriority ? "Priority" : "Optional"}
          </span>
          <span
            className={`font-body text-xl text-paper-dim transition-transform ${
              expanded ? "rotate-45" : ""
            }`}
            aria-hidden
          >
            +
          </span>
        </span>
      </button>

      {/* Declassified document insert — aged cream paper */}
      {expanded && (
        <div className="mx-4 mb-4 border border-paper/20 bg-paper px-5 py-4 text-ink shadow-[0_8px_24px_-10px_rgba(0,0,0,0.8)]">
          <p className="kicker mb-2 text-vermilion">Declassified</p>
          <p className="font-body text-[0.95rem] leading-relaxed text-ink/80">
            {idea.notes}
          </p>
        </div>
      )}
    </li>
  );
}
