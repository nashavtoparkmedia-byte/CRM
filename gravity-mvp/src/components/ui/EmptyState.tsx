import React from 'react';
import { cn } from "@/lib/utils";
import { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon | React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed bg-surface/50 p-8 text-center animate-in fade-in duration-500", className)}>
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-black/5 mb-4">
        <Icon className="h-8 w-8 text-muted" />
      </div>
      <h3 className="mb-1 text-lg font-semibold text-text">{title}</h3>
      <p className="mb-6 max-w-sm text-sm text-muted">
        {description}
      </p>
      {action && <div>{action}</div>}
    </div>
  );
}
