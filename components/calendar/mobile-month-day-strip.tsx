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
      className="mt-4 flex snap-x gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      ref={containerRef}
    >
      {days.map((day) => (
        <Link
          className={cn(
            "min-w-[5.4rem] snap-start rounded-[1.25rem] border border-border/75 bg-card px-3 py-3 shadow-[0_18px_36px_-30px_rgba(15,23,42,0.18)] transition",
            day.isSelected &&
              "border-primary/30 bg-primary/[0.06] shadow-[0_20px_40px_-30px_rgba(14,116,144,0.34)]",
          )}
          href={day.href}
          key={day.dayKey}
          ref={day.isAnchor ? anchorRef : undefined}
          scroll={false}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {day.weekdayLabel}
          </p>
          <p
            className={cn(
              "mt-2 text-2xl font-semibold tracking-tight text-foreground",
              day.isToday && "text-primary",
            )}
          >
            {day.dayNumber}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {day.eventCount === 0
              ? "No events"
              : `${day.eventCount} event${day.eventCount === 1 ? "" : "s"}`}
          </p>
        </Link>
      ))}
    </div>
  );
}
