"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTIONS } from "@/config/sections";

export function SectionDescription({ sectionKey, className }: { sectionKey: string; className?: string }) {
  const section = SECTIONS[sectionKey];
  const [isExpanded, setIsExpanded] = useState<boolean | null>(null);

  useEffect(() => {
    if (!section) return;
    
    // Check localStorage versioned key
    const storageKey = `sectionDescription:${sectionKey}:v1`;
    const saved = localStorage.getItem(storageKey);
    
    if (saved !== null) {
      setIsExpanded(JSON.parse(saved));
    } else {
      // Default: expanded for stubs, collapsed for existing
      setIsExpanded(section.isStub);
    }
  }, [sectionKey, section]);

  if (!section) return null;

  const toggle = () => {
    const newState = !isExpanded;
    setIsExpanded(newState);
    localStorage.setItem(`sectionDescription:${sectionKey}:v1`, JSON.stringify(newState));
  };

  if (isExpanded === null) return <div className="h-14 w-full animate-pulse rounded-xl bg-surface border mb-6" />;

  return (
    <div className={cn("mb-6 overflow-hidden rounded-xl border bg-surface shadow-surface transition-all", className)}>
      <button
        onClick={toggle}
        className="flex w-full items-center justify-between px-5 py-4 hover:bg-black/5 focus:outline-none"
      >
        <div className="flex items-center gap-3">
          <div className="flex bg-primary/10 rounded-lg p-2 text-primary">
            <Info className="h-5 w-5" />
          </div>
          <div className="text-left flex flex-col items-start gap-1">
            <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-text">О разделе: {section.title}</span>
                {section.badgeLabel && (
                    <span className="px-2 py-0.5 rounded-full bg-black/5 text-[10px] font-medium text-muted uppercase tracking-wider">
                        {section.badgeLabel}
                    </span>
                 )}
            </div>
            {!isExpanded && (
                <span className="text-xs text-muted font-medium pr-4 truncate max-w-xl">
                  {section.description.what}
                </span>
            )}
          </div>
        </div>
        <div className="text-muted p-1 bg-black/5 rounded-md hover:bg-black/10 transition-colors">
          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      {isExpanded && (
        <div className="px-5 pb-5 pt-2 animate-in slide-in-from-top-2 fade-in duration-200">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm mt-2 border-t pt-4">
            <div>
              <h4 className="font-semibold text-text mb-1.5 flex items-center gap-1.5 opacity-90">
                 Суть раздела
              </h4>
              <p className="text-muted text-xs leading-relaxed">{section.description.what}</p>
            </div>
            <div>
              <h4 className="font-semibold text-text mb-1.5 flex items-center gap-1.5 opacity-90">
                 Бизнес-ценность
              </h4>
              <p className="text-muted text-xs leading-relaxed">{section.description.why}</p>
            </div>
             <div>
              <h4 className="font-semibold text-text mb-1.5 flex items-center gap-1.5 opacity-90">
                 Когда использовать
              </h4>
              <p className="text-muted text-xs leading-relaxed">{section.description.when}</p>
            </div>
             <div>
              <h4 className="font-semibold text-text mb-1.5 flex items-center gap-1.5 opacity-90">
                 Ожидаемый результат
              </h4>
              <p className="text-muted text-xs leading-relaxed">{section.description.result}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
