import Link from "next/link";
import { MoveUpRight, MoveDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardCardProps {
  title: string;
  description: string;
  metric: string | number;
  trend?: string;
  icon: React.ElementType;
  href: string;
  breakdown: { label: string; value: string | number }[];
}

export function DashboardCard({
  title,
  description,
  metric,
  trend,
  icon: Icon,
  href,
  breakdown,
}: DashboardCardProps) {
  const isPositiveTrend = trend?.startsWith("+");
  const isNegativeTrend = trend?.startsWith("-");

  return (
    <Link
      href={href}
      className="group relative flex flex-col justify-between overflow-hidden rounded-xl border bg-card p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-primary hover:shadow-md h-full"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Icon className="h-5 w-5 text-primary" />
            {title}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
            {description}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-end gap-3">
        <span className="text-3xl font-bold text-foreground leading-none">
          {metric}
        </span>
        {trend && (
          <span
            className={cn(
              "flex items-center text-sm font-medium mb-1",
              isPositiveTrend
                ? "text-emerald-500"
                : isNegativeTrend
                ? "text-rose-500"
                : "text-muted-foreground"
            )}
          >
            {isPositiveTrend && <MoveUpRight className="mr-1 h-3 w-3" />}
            {isNegativeTrend && <MoveDownRight className="mr-1 h-3 w-3" />}
            {trend}
          </span>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {breakdown.map((item, index) => (
          <div
            key={index}
            className="flex items-center justify-between text-sm"
          >
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium text-foreground">{item.value}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}
