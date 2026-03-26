import React from "react";
import { SECTIONS } from "@/config/sections";
import { SectionDescription } from "@/components/ui/SectionDescription";
import { EmptyState } from "@/components/ui/EmptyState";
import { Activity, Beaker } from "lucide-react"; // Or map icons properly from sections config if preferred

interface PageShellProps {
  sectionKey: string;
}

export function PageShell({ sectionKey }: PageShellProps) {
  const section = SECTIONS[sectionKey];

  if (!section) {
    return (
      <div className="flex h-[calc(100vh-theme(spacing.32))] flex-col items-center justify-center p-8 text-center animate-in fade-in">
        <div className="mb-4 rounded-full bg-red-50 p-4 border border-red-100">
          <Activity className="h-8 w-8 text-red-500" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-foreground">Unknown section</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Please contact administrator. Section <code>{sectionKey}</code> is not registered.
        </p>
      </div>
    );
  }

  // Generate metadata info for developers (actual metadata is handled in page.tsx as per the plan)
  // ...

  return (
    <>
      {/* Optionally, Breadcrumbs could be placed here structurally */}
      <div className="mb-4 text-sm text-muted opacity-50 font-medium">
         {/* Placeholder for Breadcrumb Slot */}
         {section.breadcrumbs ? section.breadcrumbs.join(" / ") : `Главная / ${section.title}`}
      </div>

      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-text">{section.title}</h1>
        </div>
      </header>

      <SectionDescription sectionKey={sectionKey} />

      {section.isStub && (
        <EmptyState 
          icon={Beaker} 
          title="В разработке" 
          description={`Раздел "${section.title}" находится на стадии проектирования. Доступный функционал появится в ближайших обновлениях.`} 
          className="mt-8 py-16 bg-surface shadow-sm border border-transparent"
        />
      )}
    </>
  );
}
