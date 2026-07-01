"use client";

import { useState } from "react";
import { ideas, type Priority } from "@/lib/data";
import IdeaCard from "@/components/IdeaCard";

type Filter = "all" | Priority;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "must-have", label: "Must-have" },
  { value: "stretch", label: "Stretch" },
];

export default function BrainstormPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const visibleIdeas =
    filter === "all" ? ideas : ideas.filter((idea) => idea.priority === filter);

  function handleSelect(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-extrabold text-slate-900">
          💡 Final project brainstorm
        </h1>
        <p className="mt-2 text-slate-600">
          Everything I want in the Cone of Silence app. Click an idea for details.
        </p>
      </header>

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full border-2 border-slate-900 px-4 py-1.5 text-sm font-bold shadow-[2px_2px_0_0_#0f172a] transition hover:-translate-y-0.5 ${
              filter === f.value
                ? "bg-violet-500 text-white"
                : "bg-white text-slate-900"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="space-y-3">
        {visibleIdeas.map((idea) => (
          <IdeaCard
            key={idea.id}
            idea={idea}
            expanded={expandedId === idea.id}
            onSelect={handleSelect}
          />
        ))}
      </ul>
    </div>
  );
}
