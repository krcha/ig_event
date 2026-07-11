"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { cn } from "@/lib/utils";

type MobileMonthDay = {
  dayKey: string;
  href: string;
  weekdayLabel: string;
  dayNumber: number;
  eventCount: number;
  categoryCounts: Record<"club" | "live" | "culture" | "event", number>;
  isWeekend: boolean;
  isUpcoming: boolean;
  isSelected: boolean;
  isToday: boolean;
  isAnchor: boolean;
};

type MobileMonthDayStripProps = {
  days: MobileMonthDay[];
  surface?: "mobile" | "desktop";
};

export function MobileMonthDayStrip({ days, surface = "mobile" }: MobileMonthDayStripProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const hasAlignedSelectionRef = useRef(false);
  const selectedDayKey = useMemo(
    () => days.find((day) => day.isAnchor)?.dayKey ?? days.find((day) => day.isSelected)?.dayKey,
    [days],
  );

  const shouldReduceMotion = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const scrollAnchorIntoView = useCallback((behavior: ScrollBehavior) => {
    const container = containerRef.current;
    const anchor = anchorRef.current;

    if (!container || !anchor) {
      return;
    }

    const targetLeft = Math.max(
      0,
      anchor.offsetLeft - (container.clientWidth - anchor.clientWidth) / 2,
    );

    container.scrollTo({
      left: targetLeft,
      behavior,
    });
  }, []);

  useEffect(() => {
    if (!selectedDayKey) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const behavior = hasAlignedSelectionRef.current && !shouldReduceMotion() ? "smooth" : "auto";
      scrollAnchorIntoView(behavior);
      hasAlignedSelectionRef.current = true;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [scrollAnchorIntoView, selectedDayKey, shouldReduceMotion]);

  const handleDayClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();
      event.currentTarget.scrollIntoView({
        behavior: shouldReduceMotion() ? "auto" : "smooth",
        block: "nearest",
        inline: "center",
      });

      const targetUrl = new URL(event.currentTarget.href);
      const currentUrl = new URL(window.location.href);
      const hiddenCategories = currentUrl.searchParams.get("hide");

      if (hiddenCategories) {
        targetUrl.searchParams.set("hide", hiddenCategories);
      } else {
        targetUrl.searchParams.delete("hide");
      }
      targetUrl.searchParams.delete("category");

      const nextUrl = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
      startTransition(() => {
        router.push(nextUrl, { scroll: false });
      });
    },
    [router, shouldReduceMotion, startTransition],
  );

  return (
    <div
      className={cn(
        "flex snap-x snap-mandatory gap-1.5 overflow-x-auto overscroll-x-contain scroll-smooth pb-0.5 [scroll-padding-inline:0.75rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        surface === "desktop" ? "mt-1 px-0" : "-mx-1 mt-2 px-1",
      )}
      data-calendar-date-strip-surface={surface}
      data-calendar-desktop-date-strip={surface === "desktop" ? "true" : undefined}
      data-calendar-mobile-date-strip={surface === "mobile" ? "true" : undefined}
      ref={containerRef}
    >
      {days.map((day) => (
        <Link prefetch={false}
          className={cn(
            "snap-center rounded-[0.85rem] border border-border/75 bg-card px-1.5 py-1.5 text-center transition duration-200 ease-out active:scale-[0.98]",
            surface === "desktop" ? "min-w-[3.75rem] hover:border-primary/35 hover:bg-primary/[0.045]" : "min-w-[3.45rem]",
            day.isSelected && "border-primary/35 bg-primary/[0.08] text-primary shadow-[0_20px_42px_-34px_rgba(14,116,144,0.42)]",
          )}
          data-calendar-date={day.dayKey}
          data-calendar-date-event-count={day.eventCount}
          data-calendar-date-kind-counts={JSON.stringify(day.categoryCounts)}
          data-calendar-date-selected={day.isSelected ? "true" : undefined}
          data-calendar-date-weekend={day.isWeekend ? "true" : undefined}
          data-calendar-date-upcoming={day.isUpcoming ? "true" : undefined}
          data-calendar-desktop-date={surface === "desktop" ? day.dayKey : undefined}
          data-calendar-mobile-date={surface === "mobile" ? day.dayKey : undefined}
          href={day.href}
          key={day.dayKey}
          onClick={handleDayClick}
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
              data-calendar-date-count-dot="true"
            />
            <span data-calendar-date-visible-event-count="true">{day.eventCount}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
