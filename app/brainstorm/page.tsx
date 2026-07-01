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
        <h1 className="text-2xl font-bold text-white">Final project brainstorm</h1>
        <p className="mt-1 text-slate-400">
          Everything I want in the encrypted video app. Click an idea for details.
        </p>
      </header>

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
              filter === f.value
                ? "bg-emerald-500 text-slate-950"
                : "bg-slate-800 text-slate-300 hover:bg-slate-700"
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
