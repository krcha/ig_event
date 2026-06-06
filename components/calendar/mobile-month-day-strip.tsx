"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type MobileMonthDay = {
  dayKey: string;
  href: string;
  weekdayLabel: string;
  dayNumber: number;
  eventCount: number;
  isSelected: boolean;
  isToday: boolean;
  isAnchor: boolean;
};

type MobileMonthDayStripProps = {
  days: MobileMonthDay[];
};

export function MobileMonthDayStrip({ days }: MobileMonthDayStripProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const anchor = anchorRef.current;

    if (!container || !anchor) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        left: Math.max(0, anchor.offsetLeft - 12),
        behavior: "auto",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [days]);

  return (
    <div
      className="-mx-1 mt-2 flex snap-x gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      ref={containerRef}
    >
      {days.map((day) => (
        <Link
          className={cn(
            "min-w-[3.45rem] snap-start rounded-[0.85rem] border border-border/75 bg-card px-1.5 py-1.5 text-center transition",
            day.isSelected && "border-primary/35 bg-primary/[0.08] text-primary shadow-[0_20px_42px_-34px_rgba(14,116,144,0.42)]",
          )}
          href={day.href}
          key={day.dayKey}
          ref={day.isAnchor ? anchorRef : undefined}
          scroll={false}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {day.weekdayLabel}
          </p>
          <p
            className={cn(
              "mt-0.5 text-base font-semibold leading-none tracking-tight text-foreground",
              day.isToday && "text-primary",
              day.isSelected && "text-primary",
            )}
          >
            {day.dayNumber}
          </p>
          <div className="mt-1 flex items-center justify-center gap-1 text-[11px] font-semibold text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                day.eventCount > 0 ? "bg-primary" : "bg-border",
              )}
            />
            <span>{day.eventCount}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
