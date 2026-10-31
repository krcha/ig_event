"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { EVENT_CATEGORY_TONES, type EventCategoryKind } from "@/components/events/event-meta";
import {
  EVENT_PRIMARY_CATEGORIES,
  getHiddenCategoriesAfterCategoryToggle,
  normalizeEventCategoryKey,
  normalizeHiddenEventCategories,
} from "@/lib/taxonomy/event-categories";
import { cn } from "@/lib/utils";

const CATEGORY_CHIPS: Array<{ key: "all" | EventCategoryKind; label: string }> = [
  { key: "all", label: "All" },
  ...EVENT_PRIMARY_CATEGORIES,
];
const CATEGORY_KEYS = CATEGORY_CHIPS.map((chip) => chip.key).filter(
  (key): key is EventCategoryKind => key !== "all",
);

const CALENDAR_DATE_COUNT_SELECTOR = "[data-calendar-date-kind-counts]";

type EventKindToggleChipsProps = {
  afterAll?: ReactNode;
  children?: ReactNode;
  initialHiddenCategories?: readonly EventCategoryKind[];
  singleSelection?: boolean;
};

type CategoryCountMap = Partial<Record<EventCategoryKind, number>>;

function normalizeHiddenCategories(value: string | readonly string[] | null | undefined): EventCategoryKind[] {
  const values: readonly string[] = typeof value === "string" ? value.split(",") : (value ?? []);
  return normalizeHiddenEventCategories(values);
}

function formatHiddenCategories(categories: readonly EventCategoryKind[]): string | undefined {
  return categories.length > 0 ? categories.join(",") : undefined;
}

function pluralize(value: number): string {
  return `${value} ${value === 1 ? "event" : "events"}`;
}

function getCurrentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function readHiddenCategoriesFromLocation(): EventCategoryKind[] {
  if (typeof window === "undefined") {
    return [];
  }

  return normalizeHiddenCategories(new URL(window.location.href).searchParams.get("hide"));
}

function buildHiddenCategoriesUrl(categories: readonly EventCategoryKind[], pathname: string | null): string {
  const url = new URL(window.location.href);
  const hiddenParam = formatHiddenCategories(categories);

  if (pathname) {
    url.pathname = pathname;
  }

  if (hiddenParam) {
    url.searchParams.set("hide", hiddenParam);
  } else {
    url.searchParams.delete("hide");
  }

  // Remove the previous include-only category query if it exists from older links.
  url.searchParams.delete("category");
  return `${url.pathname}${url.search}${url.hash}`;
}

function parseCategoryCounts(rawValue: string | undefined): CategoryCountMap {
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const counts: CategoryCountMap = {};
    CATEGORY_KEYS.forEach((key) => {
      const value = parsed[key];
      counts[key] = typeof value === "number" && Number.isFinite(value) ? value : 0;
    });
    return counts;
  } catch {
    return {};
  }
}

function getVisibleCountFromCategoryCounts(
  counts: CategoryCountMap,
  hiddenCategories: readonly EventCategoryKind[],
): number {
  const hiddenSet = new Set(hiddenCategories);
  return CATEGORY_KEYS.reduce((total, category) => {
    if (hiddenSet.has(category)) {
      return total;
    }
    return total + (counts[category] ?? 0);
  }, 0);
}

function setVisibleText(target: HTMLElement, text: string) {
  if (target.getAttribute?.("aria-busy") === "true") return;
  if (target.textContent !== text) target.textContent = text;
}

function setMetricValue(metricKey: string, value: number) {
  document.querySelectorAll<HTMLElement>(`[data-calendar-stat-value="${metricKey}"]`).forEach((target) => {
    setVisibleText(target, String(value));
  });
}

function syncDateStripAndMetricCounts(categories: readonly EventCategoryKind[]) {
  const countedDayKeys = new Set<string>();
  let totalVisibleEvents = 0;
  let activeDayCount = 0;
  let weekendVisibleEvents = 0;

  document.querySelectorAll<HTMLElement>(CALENDAR_DATE_COUNT_SELECTOR).forEach((dateLink) => {
    const counts = parseCategoryCounts(dateLink.dataset.calendarDateKindCounts);
    const visibleCount = getVisibleCountFromCategoryCounts(counts, categories);
    const dayKey = dateLink.dataset.calendarDate;
    const shouldCountForStats = Boolean(dayKey && !countedDayKeys.has(dayKey) && dateLink.dataset.calendarDateStatScope !== "week");
    const isWeekend = dateLink.dataset.calendarDateWeekend === "true";
    const isUpcoming = dateLink.dataset.calendarDateUpcoming === "true";

    if (shouldCountForStats && dayKey) {
      countedDayKeys.add(dayKey);
      totalVisibleEvents += visibleCount;
      if (visibleCount > 0) {
        if (isUpcoming) {
          activeDayCount += 1;
        }
        if (isWeekend) {
          weekendVisibleEvents += visibleCount;
        }
      }
    }

    dateLink.dataset.calendarVisibleEventCount = String(visibleCount);
    dateLink.querySelectorAll<HTMLElement>("[data-calendar-date-visible-event-count]").forEach((target) => {
      setVisibleText(target, String(visibleCount));
    });
    dateLink.querySelectorAll<HTMLElement>("[data-calendar-date-count-dot]").forEach((target) => {
      target.classList.toggle("bg-primary", visibleCount > 0);
      target.classList.toggle("bg-border", visibleCount === 0);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-calendar-week]").forEach((week) => {
    const dates = Array.from(week.querySelectorAll<HTMLElement>("[data-calendar-week-date]"));
    const maxCount = Math.max(1, ...dates.map((date) => Number(date.dataset.calendarVisibleEventCount ?? 0)));
    dates.forEach((date) => {
      const count = Number(date.dataset.calendarVisibleEventCount ?? 0);
      date.querySelector<HTMLElement>("[data-calendar-week-water]")?.style.setProperty(
        "--week-fill", `${Math.max(6, Math.min(100, count / maxCount * 100))}%`,
      );
    });
  });

  setMetricValue("events", totalVisibleEvents);
  setMetricValue("active-days", activeDayCount);
  setMetricValue("weekend", weekendVisibleEvents);
}

function applyAgendaVisibility(categories: readonly EventCategoryKind[]) {
  const hiddenSet = new Set(categories);

  document.querySelectorAll<HTMLElement>("[data-calendar-agenda-scope]").forEach((scope) => {
    const rows = Array.from(scope.querySelectorAll<HTMLElement>("[data-calendar-event-kind]"));
    let visibleCount = 0;

    rows.forEach((row) => {
      const eventKind = row.dataset.calendarEventKind;
      const shouldHide = Boolean(eventKind && hiddenSet.has(eventKind as EventCategoryKind));
      row.hidden = shouldHide;
      row.dataset.calendarHiddenByKind = shouldHide ? "true" : "false";
      if (!shouldHide) {
        visibleCount += 1;
      }
    });

    scope.querySelectorAll<HTMLElement>("[data-calendar-venue-group]").forEach((group) => {
      const visibleGroupCount = Array.from(
        group.querySelectorAll<HTMLElement>("[data-calendar-event-kind]"),
      ).filter((row) => !row.hidden).length;

      group.hidden = visibleGroupCount === 0;
      group.querySelectorAll<HTMLElement>("[data-calendar-venue-group-visible-count]").forEach((target) => {
        setVisibleText(target, pluralize(visibleGroupCount));
      });
    });

    scope.querySelectorAll<HTMLElement>("[data-calendar-venue-groups]").forEach((container) => {
      container.hidden = !Array.from(
        container.querySelectorAll<HTMLElement>("[data-calendar-venue-group]"),
      ).some((group) => !group.hidden);
    });

    scope.querySelectorAll<HTMLElement>("[data-calendar-time-band]").forEach((timeBand) => {
      const visibleTimeBandCount = Array.from(
        timeBand.querySelectorAll<HTMLElement>("[data-calendar-event-kind]"),
      ).filter((row) => !row.hidden).length;

      timeBand.hidden = visibleTimeBandCount === 0;
      timeBand
        .querySelectorAll<HTMLElement>("[data-calendar-time-band-visible-count]")
        .forEach((target) => {
          setVisibleText(target, pluralize(visibleTimeBandCount));
        });
    });

    scope.querySelectorAll<HTMLElement>("[data-calendar-visible-event-count]").forEach((target) => {
      setVisibleText(target, pluralize(visibleCount));
    });
    if (scope.dataset.calendarAgendaScope === "mobile-week") {
      document.querySelectorAll<HTMLElement>("[data-calendar-mobile-day-count]").forEach((target) => {
        setVisibleText(target, String(visibleCount));
      });
    }
    scope.querySelectorAll<HTMLElement>("[data-calendar-empty-state]").forEach((emptyState) => {
      emptyState.hidden = visibleCount > 0;
    });
  });

  document.querySelectorAll<HTMLElement>('[data-calendar-clear-filter^="category-"]').forEach((control) => {
    const category = control.dataset.calendarClearFilter?.replace("category-", "");
    control.hidden = !Boolean(category && hiddenSet.has(category as EventCategoryKind));
  });

  syncDateStripAndMetricCounts(categories);
}

export function EventKindToggleChips({
  afterAll,
  children,
  initialHiddenCategories = [],
  singleSelection = false,
}: EventKindToggleChipsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const initialHiddenCategoryKey = useMemo(
    () => formatHiddenCategories(normalizeHiddenCategories(initialHiddenCategories)) ?? "",
    [initialHiddenCategories],
  );
  const [hiddenCategories, setHiddenCategories] = useState<EventCategoryKind[]>(() =>
    normalizeHiddenCategories(initialHiddenCategories),
  );
  const appliedCategoryKey = useRef(initialHiddenCategoryKey);
  const hiddenSet = useMemo(() => new Set(hiddenCategories), [hiddenCategories]);
  const selectedCategory = hiddenCategories.length === CATEGORY_KEYS.length - 1
    ? CATEGORY_KEYS.find((key) => !hiddenSet.has(key)) ?? "all"
    : "all";

  const setHiddenCategoriesAndUrl = useCallback(
    (nextCategories: EventCategoryKind[]) => {
      const normalized = normalizeHiddenCategories(nextCategories);
      const targetUrl = buildHiddenCategoriesUrl(normalized, pathname || "/");

      setHiddenCategories(normalized);
      const nextKey = formatHiddenCategories(normalized) ?? "";
      if (appliedCategoryKey.current !== nextKey) {
        applyAgendaVisibility(normalized);
        appliedCategoryKey.current = nextKey;
      }

      if (targetUrl !== getCurrentRelativeUrl()) {
        startTransition(() => {
          router.replace(targetUrl, { scroll: false });
        });
      }
    },
    [pathname, router, startTransition],
  );

  useEffect(() => {
    const nextCategories = normalizeHiddenCategories(initialHiddenCategoryKey);
    // The server already applied this state to rows, metrics and date strips.
    // Do not replace nodes owned by another island while it is hydrating.
    appliedCategoryKey.current = initialHiddenCategoryKey;
    setHiddenCategories((currentCategories) => {
      const currentKey = formatHiddenCategories(currentCategories) ?? "";
      const nextKey = formatHiddenCategories(nextCategories) ?? "";
      return currentKey === nextKey ? currentCategories : nextCategories;
    });
  }, [initialHiddenCategoryKey]);

  useEffect(() => {
    const nextKey = formatHiddenCategories(hiddenCategories) ?? "";
    if (appliedCategoryKey.current === nextKey) return;
    applyAgendaVisibility(hiddenCategories);
    appliedCategoryKey.current = nextKey;
  }, [hiddenCategories]);

  useEffect(() => {
    const onPopState = () => {
      setHiddenCategories(readHiddenCategoriesFromLocation());
    };

    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const control = target.closest<HTMLAnchorElement>('[data-calendar-clear-filter^="category-"]');
      if (!control) {
        return;
      }

      const category = normalizeEventCategoryKey(control.dataset.calendarClearFilter?.replace("category-", ""));
      if (!category) {
        return;
      }

      event.preventDefault();
      const next = hiddenCategories.filter((item) => item !== category);
      setHiddenCategoriesAndUrl(next);
    };

    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onDocumentClick);

    return () => {
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onDocumentClick);
    };
  }, [hiddenCategories, setHiddenCategoriesAndUrl]);

  function toggleCategory(category: EventCategoryKind) {
    const next = singleSelection
      ? CATEGORY_KEYS.filter((key) => key !== category)
      : getHiddenCategoriesAfterCategoryToggle(hiddenCategories, category);
    setHiddenCategoriesAndUrl(next);
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5" data-calendar-mobile-filter-chips="true" data-calendar-category-selection={singleSelection ? "single" : "multiple"}>
      <nav
        aria-label={afterAll ? "Selected day filters" : "Selected day categories"}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {CATEGORY_CHIPS.flatMap((chip) => {
          if (chip.key === "all") {
            const isAllEnabled = singleSelection ? selectedCategory === "all" : hiddenCategories.length === 0;

            const allChip = (
              <button
                aria-pressed={isAllEnabled}
                className={cn(
                  "inline-flex min-h-8 flex-none items-center rounded-full px-2.5 text-[11px] font-semibold transition hover:opacity-90",
                  singleSelection
                    ? isAllEnabled ? "border border-primary bg-primary text-primary-foreground" : "border border-input bg-card text-foreground"
                    : isAllEnabled
                      ? "bg-primary/15 text-primary shadow-[0_16px_34px_-28px_rgba(113,112,255,0.9)]"
                      : "bg-white/[0.045] text-muted-foreground hover:text-foreground",
                )}
                data-calendar-kind-toggle="all"
                key={chip.key}
                onClick={() => setHiddenCategoriesAndUrl([])}
                type="button"
              >
                {chip.label}
              </button>
            );
            return afterAll ? [allChip, <span className="contents" key="after-all">{afterAll}</span>] : [allChip];
          }

          const category = chip.key as EventCategoryKind;
          const isHidden = hiddenSet.has(category);
          const isActive = singleSelection ? selectedCategory === category : !isHidden;
          const tone = EVENT_CATEGORY_TONES[category];

          return (
            <button
              aria-pressed={isActive}
              className={cn(
                "inline-flex min-h-8 flex-none items-center rounded-full px-2.5 text-[11px] font-semibold transition hover:opacity-90",
                singleSelection
                  ? isActive ? "border border-primary bg-primary text-primary-foreground" : "border border-input bg-card text-foreground"
                  : isHidden
                    ? "bg-white/[0.04] text-muted-foreground opacity-70 ring-1 ring-border/60"
                    : "shadow-[0_16px_34px_-28px_rgba(0,0,0,0.85)]",
              )}
              data-calendar-kind-toggle={chip.key}
              key={chip.key}
              onClick={() => toggleCategory(category)}
              style={singleSelection || isHidden ? undefined : { backgroundColor: tone.backgroundColor, color: tone.color }}
              type="button"
            >
              {singleSelection ? <span aria-hidden="true" className="mr-1.5 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: isActive ? "currentColor" : tone.color }} /> : null}
              <span className={!singleSelection && isHidden ? "line-through" : undefined}>{chip.label}</span>
              {!singleSelection && isHidden ? (
                <span aria-hidden="true" className="ml-1 text-[10px] opacity-80">
                  off
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
