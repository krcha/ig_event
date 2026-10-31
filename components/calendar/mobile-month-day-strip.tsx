"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useTransition } from "react";
import { cn } from "@/lib/utils";
import type { EventPrimaryCategory } from "@/lib/taxonomy/event-categories";
import { useCalendarOverviewDays } from "./calendar-overview";

type MobileMonthDay = {
  dayKey: string;
  href: string;
  weekdayLabel: string;
  dayNumber: number;
  eventCount: number;
  categoryCounts: Record<EventPrimaryCategory, number>;
  isWeekend: boolean;
  isUpcoming: boolean;
  isSelected: boolean;
  isToday: boolean;
  isAnchor: boolean;
  countsPending?: boolean;
};

type MobileMonthDayStripProps = {
  days: MobileMonthDay[];
  surface?: "mobile" | "desktop";
};

const DATE_STRIP_STORAGE_PREFIX = "eventzeka:date-strip:v1:";

function readStoredPosition(key: string): { day: string; left: number } | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    const value = raw ? JSON.parse(raw) as { day?: unknown; left?: unknown } : null;
    return value && typeof value.day === "string" && typeof value.left === "number" &&
      Number.isFinite(value.left) && value.left >= 0
      ? { day: value.day, left: value.left }
      : null;
  } catch {
    return null;
  }
}

function getAnchorPosition(container: HTMLDivElement, anchor: HTMLAnchorElement) {
  const containerBounds = container.getBoundingClientRect();
  const anchorBounds = anchor.getBoundingClientRect();
  const left = container.scrollLeft + anchorBounds.left - containerBounds.left;
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  return {
    centeredLeft: Math.min(maxLeft, Math.max(0, left - (container.clientWidth - anchorBounds.width) / 2)),
    isVisibleAt: (scrollLeft: number) => left >= scrollLeft &&
      left + anchorBounds.width <= scrollLeft + container.clientWidth,
    maxLeft,
  };
}

export function MobileMonthDayStrip({ days: initialDays, surface = "mobile" }: MobileMonthDayStripProps) {
  const days = useCalendarOverviewDays(initialDays);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const alignedStorageKeyRef = useRef<string | null>(null);
  const selectedDayKey = useMemo(
    () => days.find((day) => day.isAnchor)?.dayKey ?? days.find((day) => day.isSelected)?.dayKey,
    [days],
  );
  const selectedDayKeyRef = useRef(selectedDayKey);
  const storageKey = `${DATE_STRIP_STORAGE_PREFIX}${surface}:${days[0]?.dayKey.slice(0, 7) ?? ""}`;
  const activeStorageKeyRef = useRef(storageKey);
  useLayoutEffect(() => {
    selectedDayKeyRef.current = selectedDayKey;
    activeStorageKeyRef.current = storageKey;
  }, [selectedDayKey, storageKey]);

  const shouldReduceMotion = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const scrollAnchorIntoView = useCallback((anchor: HTMLAnchorElement, allowSmooth: boolean) => {
    const container = containerRef.current;

    if (!container || container.clientWidth === 0) {
      return;
    }

    const { centeredLeft } = getAnchorPosition(container, anchor);
    const nearby = Math.abs(centeredLeft - container.scrollLeft) <= container.clientWidth;
    container.scrollTo({
      left: centeredLeft,
      behavior: allowSmooth && nearby && !shouldReduceMotion() ? "smooth" : "instant",
    });
  }, [shouldReduceMotion]);

  useLayoutEffect(() => {
    if (!selectedDayKey) {
      return;
    }

    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) {
      return;
    }

    function alignSelection(allowSmooth: boolean) {
      if (!container || !anchor || container.clientWidth === 0) {
        return;
      }
      const position = getAnchorPosition(container, anchor);
      if (alignedStorageKeyRef.current !== storageKey) {
        const stored = readStoredPosition(storageKey);
        const storedLeft = stored ? Math.min(stored.left, position.maxLeft) : null;
        const restoreStored = stored && storedLeft !== null &&
          (stored.day === selectedDayKey || position.isVisibleAt(storedLeft));
        // "auto" can inherit CSS smooth scrolling. Initial alignment and
        // document/back restoration must never animate from the month's start.
        container.scrollTo({
          left: restoreStored ? storedLeft : position.centeredLeft,
          behavior: "instant",
        });
        alignedStorageKeyRef.current = storageKey;
      } else if (!position.isVisibleAt(container.scrollLeft)) {
        scrollAnchorIntoView(anchor, allowSmooth);
      }
    }

    alignSelection(true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null
      : new ResizeObserver(() => alignSelection(false));
    resizeObserver?.observe(container);

    return () => resizeObserver?.disconnect();
  }, [scrollAnchorIntoView, selectedDayKey, storageKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let saveFrame = 0;
    function savePosition() {
      if (!container || container.clientWidth === 0 || activeStorageKeyRef.current !== storageKey) {
        return;
      }
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify({
          day: selectedDayKeyRef.current,
          left: container.scrollLeft,
        }));
      } catch {
        // Date navigation remains available when storage is disabled or full.
      }
    }
    function onScroll() {
      if (saveFrame !== 0) {
        return;
      }
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = 0;
        savePosition();
      });
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      if (saveFrame !== 0) window.cancelAnimationFrame(saveFrame);
      savePosition();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", savePosition);
    };
  }, [storageKey]);

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
      scrollAnchorIntoView(event.currentTarget, true);

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
    [router, scrollAnchorIntoView, startTransition],
  );

  return (
    <div
      className={cn(
        "flex snap-x snap-mandatory gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 [scroll-padding-inline:0.75rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
          data-calendar-client-navigation="true"
          data-calendar-date-weekend={day.isWeekend ? "true" : undefined}
          data-calendar-date-upcoming={day.isUpcoming ? "true" : undefined}
          data-calendar-desktop-date={surface === "desktop" ? day.dayKey : undefined}
          data-calendar-mobile-date={surface === "mobile" ? day.dayKey : undefined}
          href={day.href}
          key={day.dayKey}
          onClick={handleDayClick}
          ref={day.dayKey === selectedDayKey ? anchorRef : undefined}
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
            <span aria-busy={day.countsPending || undefined} data-calendar-date-visible-event-count="true">{day.countsPending ? "\u00b7" : day.eventCount}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
