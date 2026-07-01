"use client";

import type { Idea } from "@/lib/data";

interface IdeaCardProps {
  idea: Idea;
  expanded: boolean;
  onSelect: (id: string) => void;
}

export default function IdeaCard({ idea, expanded, onSelect }: IdeaCardProps) {
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900">
      <button
        type="button"
        onClick={() => onSelect(idea.id)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <span className="font-medium text-white">{idea.title}</span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
            idea.priority === "must-have"
              ? "bg-emerald-500/20 text-emerald-300"
              : "bg-amber-500/20 text-amber-300"
          }`}
        >
          {idea.priority === "must-have" ? "Must-have" : "Stretch"}
        </span>
      </button>

      {expanded && (
        <p className="border-t border-slate-800 px-4 py-3 text-sm text-slate-300">
          {idea.notes}
        </p>
      )}
    </li>
  );
}
