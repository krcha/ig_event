"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { EVENT_CATEGORY_TONES, type EventCategoryKind } from "@/components/events/event-meta";
import { cn } from "@/lib/utils";

const CATEGORY_CHIPS: Array<{ key: "all" | EventCategoryKind; label: string }> = [
  { key: "all", label: "All" },
  { key: "club", label: "Club" },
  { key: "live", label: "Live" },
  { key: "culture", label: "Culture" },
  { key: "event", label: "Event" },
];
const CATEGORY_KEYS = CATEGORY_CHIPS.map((chip) => chip.key).filter(
  (key): key is EventCategoryKind => key !== "all",
);
const CATEGORY_KEY_SET = new Set<string>(CATEGORY_KEYS);

type EventKindToggleChipsProps = {
  children?: ReactNode;
  initialHiddenCategories?: readonly EventCategoryKind[];
};

function normalizeHiddenCategories(value: string | readonly string[] | null | undefined): EventCategoryKind[] {
  const values: readonly string[] = typeof value === "string" ? value.split(",") : (value ?? []);
  const requested = new Set(
    values.map((item: string) => item.trim()).filter((item): item is EventCategoryKind => CATEGORY_KEY_SET.has(item)),
  );

  return CATEGORY_KEYS.filter((key) => requested.has(key));
}

function formatHiddenCategories(categories: readonly EventCategoryKind[]): string | undefined {
  return categories.length > 0 ? categories.join(",") : undefined;
}

function pluralize(value: number): string {
  return `${value} ${value === 1 ? "event" : "events"}`;
}

function readHiddenCategoriesFromLocation(): EventCategoryKind[] {
  if (typeof window === "undefined") {
    return [];
  }

  return normalizeHiddenCategories(new URL(window.location.href).searchParams.get("hide"));
}

function writeHiddenCategoriesToUrl(categories: readonly EventCategoryKind[]) {
  const url = new URL(window.location.href);
  const hiddenParam = formatHiddenCategories(categories);

  if (hiddenParam) {
    url.searchParams.set("hide", hiddenParam);
  } else {
    url.searchParams.delete("hide");
  }

  // Remove the previous include-only category query if it exists from older links.
  url.searchParams.delete("category");
  window.history.pushState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function syncCalendarLinksAndForms(categories: readonly EventCategoryKind[]) {
  const hiddenParam = formatHiddenCategories(categories);

  document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href) {
      return;
    }

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== "/") {
      return;
    }

    if (hiddenParam) {
      url.searchParams.set("hide", hiddenParam);
    } else {
      url.searchParams.delete("hide");
    }
    url.searchParams.delete("category");
    anchor.setAttribute("href", `${url.pathname}${url.search}${url.hash}`);
  });

  document.querySelectorAll<HTMLFormElement>('form[method="get"]').forEach((form) => {
    if (!form.querySelector('input[name="month"]')) {
      return;
    }

    form.querySelector('input[name="category"]')?.remove();
    let hideInput = form.querySelector<HTMLInputElement>('input[name="hide"]');

    if (!hiddenParam) {
      hideInput?.remove();
      return;
    }

    if (!hideInput) {
      hideInput = document.createElement("input");
      hideInput.type = "hidden";
      hideInput.name = "hide";
      form.appendChild(hideInput);
    }
    hideInput.value = hiddenParam;
  });
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

    scope.querySelectorAll<HTMLElement>("[data-calendar-visible-event-count]").forEach((target) => {
      target.textContent = pluralize(visibleCount);
    });
    scope.querySelectorAll<HTMLElement>("[data-calendar-empty-state]").forEach((emptyState) => {
      emptyState.hidden = visibleCount > 0;
    });
  });

  document.querySelectorAll<HTMLElement>('[data-calendar-clear-filter^="category-"]').forEach((control) => {
    const category = control.dataset.calendarClearFilter?.replace("category-", "");
    control.hidden = !Boolean(category && hiddenSet.has(category as EventCategoryKind));
  });
}

export function EventKindToggleChips({
  children,
  initialHiddenCategories = [],
}: EventKindToggleChipsProps) {
  const [hiddenCategories, setHiddenCategories] = useState<EventCategoryKind[]>(() =>
    normalizeHiddenCategories(initialHiddenCategories),
  );
  const hiddenSet = useMemo(() => new Set(hiddenCategories), [hiddenCategories]);

  const setHiddenCategoriesAndUrl = useCallback((nextCategories: EventCategoryKind[]) => {
    const normalized = normalizeHiddenCategories(nextCategories);
    setHiddenCategories(normalized);
    writeHiddenCategoriesToUrl(normalized);
  }, []);

  useEffect(() => {
    applyAgendaVisibility(hiddenCategories);
    syncCalendarLinksAndForms(hiddenCategories);
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

      const category = control.dataset.calendarClearFilter?.replace("category-", "");
      if (!category || !CATEGORY_KEY_SET.has(category)) {
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
    const next = hiddenSet.has(category)
      ? hiddenCategories.filter((item) => item !== category)
      : [...hiddenCategories, category];
    setHiddenCategoriesAndUrl(next);
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5" data-calendar-mobile-filter-chips="true">
      <nav
        aria-label="Selected day categories"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {CATEGORY_CHIPS.map((chip) => {
          if (chip.key === "all") {
            const isAllEnabled = hiddenCategories.length === 0;

            return (
              <button
                aria-pressed={isAllEnabled}
                className={cn(
                  "inline-flex min-h-8 flex-none items-center rounded-full px-2.5 text-[11px] font-semibold transition hover:opacity-90",
                  isAllEnabled
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
          }

          const category = chip.key as EventCategoryKind;
          const isHidden = hiddenSet.has(category);
          const tone = EVENT_CATEGORY_TONES[category];

          return (
            <button
              aria-pressed={!isHidden}
              className={cn(
                "inline-flex min-h-8 flex-none items-center rounded-full px-2.5 text-[11px] font-semibold transition hover:opacity-90",
                isHidden
                  ? "bg-white/[0.04] text-muted-foreground opacity-70 ring-1 ring-border/60"
                  : "shadow-[0_16px_34px_-28px_rgba(0,0,0,0.85)]",
              )}
              data-calendar-kind-toggle={chip.key}
              key={chip.key}
              onClick={() => toggleCategory(category)}
              style={isHidden ? undefined : { backgroundColor: tone.backgroundColor, color: tone.color }}
              type="button"
            >
              <span className={isHidden ? "line-through" : undefined}>{chip.label}</span>
              {isHidden ? (
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
