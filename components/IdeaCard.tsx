"use client";

import type { Idea } from "@/lib/data";

interface IdeaCardProps {
  idea: Idea;
  expanded: boolean;
  onSelect: (id: string) => void;
}

export default function IdeaCard({ idea, expanded, onSelect }: IdeaCardProps) {
  return (
    <li className="overflow-hidden rounded-2xl border-4 border-slate-900 bg-white shadow-[4px_4px_0_0_#0f172a]">
      <button
        type="button"
        onClick={() => onSelect(idea.id)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition hover:bg-amber-50"
      >
        <span className="font-extrabold text-slate-900">{idea.title}</span>
        <span
          className={`shrink-0 rounded-full border-2 border-slate-900 px-2 py-0.5 text-xs font-bold ${
            idea.priority === "must-have"
              ? "bg-teal-300 text-slate-900"
              : "bg-orange-300 text-slate-900"
          }`}
        >
          {idea.priority === "must-have" ? "Must-have" : "Stretch"}
        </span>
      </button>

      {expanded && (
        <p className="border-t-4 border-slate-900 bg-violet-50 px-4 py-3 text-sm font-medium text-slate-700">
          {idea.notes}
        </p>
      )}
    </li>
  );
}
