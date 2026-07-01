"use client";

import { useState } from "react";
import { ideas, type Priority } from "@/lib/data";
import IdeaCard from "@/components/IdeaCard";

type Filter = "all" | Priority;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All Files" },
  { value: "must-have", label: "Priority" },
  { value: "stretch", label: "Optional" },
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
    <div className="space-y-8">
      <header className="hairline border-b pb-6">
        <div className="flex items-center justify-between">
          <p className="kicker text-brass">File No. CS-001</p>
          <span className="stamp rotate-[3deg] text-vermilion">Classified</span>
        </div>
        <h1 className="mt-3 font-display text-6xl leading-[0.9] tracking-[0.04em] text-paper">
          Mission Dossier
        </h1>
        <p className="mt-3 max-w-lg font-body text-lg italic text-paper-dim">
          Every capability the Cone of Silence must deliver. Tap a file to declassify
          the details.
        </p>
      </header>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-3">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={`stamp transition ${
              filter === f.value
                ? "bg-vermilion text-paper"
                : "text-paper-dim hover:text-brass"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="space-y-4">
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
