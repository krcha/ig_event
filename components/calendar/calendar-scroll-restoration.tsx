"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

const CALENDAR_SCROLL_KEY_PREFIX = "ig-event:calendar-scroll:";
const CALENDAR_RETURN_URL_STORAGE_KEY = "ig-event:calendar-return-url";
const CALENDAR_RETURN_EVENT_PATH_STORAGE_KEY = "ig-event:calendar-return-event-path";
const CALENDAR_RESTORE_REQUEST_STORAGE_KEY = "ig-event:calendar-restore-request";
const CALENDAR_EVENT_LINK_SELECTOR = "a[data-calendar-event-link='true']";
const CALENDAR_SCROLL_REGION_SELECTOR = "[data-calendar-scroll-region]";
const RESTORE_DELAYS_MS = [0, 40, 120, 280, 600, 1_000, 1_600] as const;

type ScrollPoint = {
  left: number;
  top: number;
};

type CalendarScrollSnapshot = {
  regions: Record<string, ScrollPoint>;
  updatedAt: number;
  x: number;
  y: number;
};

type EventCalendarBackLinkProps = {
  children: ReactNode;
  className?: string;
  href: string;
};

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getCurrentRelativeUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function getCurrentEventPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function getScrollStorageKey(calendarUrl: string): string {
  return `${CALENDAR_SCROLL_KEY_PREFIX}${calendarUrl}`;
}

function normalizeSameOriginUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
}

function normalizeCalendarHref(value: string | null | undefined): string | null {
  const url = normalizeSameOriginUrl(value);
  if (!url) {
    return null;
  }

  if (url.pathname !== "/" && url.pathname !== "/calendar" && url.pathname !== "/events") {
    return null;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizeEventPath(value: string | null | undefined): string | null {
  const url = normalizeSameOriginUrl(value);
  if (!url || !url.pathname.startsWith("/events/")) {
    return null;
  }

  return `${url.pathname}${url.search}`;
}

function getScrollRegionId(element: HTMLElement, index: number): string {
  return element.getAttribute("data-calendar-scroll-region") || `region-${index}`;
}

function readCalendarScrollSnapshot(
  storage: Storage,
  calendarUrl: string,
): CalendarScrollSnapshot | null {
  const rawValue = storage.getItem(getScrollStorageKey(calendarUrl));
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<CalendarScrollSnapshot>;
    return {
      regions:
        parsed.regions && typeof parsed.regions === "object" && !Array.isArray(parsed.regions)
          ? Object.fromEntries(
              Object.entries(parsed.regions).map(([key, value]) => {
                const point = value as Partial<ScrollPoint>;
                return [
                  key,
                  {
                    left: Number.isFinite(point.left) ? Number(point.left) : 0,
                    top: Number.isFinite(point.top) ? Number(point.top) : 0,
                  },
                ];
              }),
            )
          : {},
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
      x: Number.isFinite(parsed.x) ? Number(parsed.x) : 0,
      y: Number.isFinite(parsed.y) ? Number(parsed.y) : 0,
    };
  } catch {
    return null;
  }
}

function saveCalendarScrollPosition(storage: Storage, calendarUrl: string): void {
  const regions: Record<string, ScrollPoint> = {};
  document.querySelectorAll<HTMLElement>(CALENDAR_SCROLL_REGION_SELECTOR).forEach((element, index) => {
    regions[getScrollRegionId(element, index)] = {
      left: element.scrollLeft,
      top: element.scrollTop,
    };
  });

  const snapshot: CalendarScrollSnapshot = {
    regions,
    updatedAt: Date.now(),
    x: window.scrollX,
    y: window.scrollY,
  };

  storage.setItem(getScrollStorageKey(calendarUrl), JSON.stringify(snapshot));
}

function restoreCalendarScrollPosition(storage: Storage, calendarUrl: string): void {
  const snapshot = readCalendarScrollSnapshot(storage, calendarUrl);
  if (!snapshot) {
    return;
  }

  window.scrollTo({ left: snapshot.x, top: snapshot.y, behavior: "auto" });

  document.querySelectorAll<HTMLElement>(CALENDAR_SCROLL_REGION_SELECTOR).forEach((element, index) => {
    const position = snapshot.regions[getScrollRegionId(element, index)];
    if (!position) {
      return;
    }

    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  });
}

function getStoredCalendarReturnHref(storage: Storage): string | null {
  const storedHref = normalizeCalendarHref(storage.getItem(CALENDAR_RETURN_URL_STORAGE_KEY));
  if (!storedHref) {
    return null;
  }

  const storedEventPath = storage.getItem(CALENDAR_RETURN_EVENT_PATH_STORAGE_KEY);
  if (storedEventPath && storedEventPath !== getCurrentEventPath()) {
    return null;
  }

  return storedHref;
}

export function CalendarScrollRestoration() {
  useEffect(() => {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }

    let restoreInProgress = false;
    let leavingForEventDetail = false;
    let saveFrame = 0;
    const restoreTimers: number[] = [];
    const previousScrollRestoration = "scrollRestoration" in window.history
      ? window.history.scrollRestoration
      : undefined;

    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }

    const saveNow = () => {
      if (restoreInProgress || leavingForEventDetail) {
        return;
      }
      saveCalendarScrollPosition(storage, getCurrentRelativeUrl());
    };

    const scheduleSave = () => {
      if (saveFrame !== 0) {
        return;
      }
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = 0;
        saveNow();
      });
    };

    const handleEventLinkClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const link = target.closest<HTMLAnchorElement>(CALENDAR_EVENT_LINK_SELECTOR);
      const eventPath = normalizeEventPath(link?.href);
      if (!eventPath) {
        return;
      }

      const calendarUrl = getCurrentRelativeUrl();
      saveCalendarScrollPosition(storage, calendarUrl);
      leavingForEventDetail = true;
      storage.setItem(CALENDAR_RETURN_URL_STORAGE_KEY, calendarUrl);
      storage.setItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY, calendarUrl);
      storage.setItem(CALENDAR_RETURN_EVENT_PATH_STORAGE_KEY, eventPath);
    };

    const requestedRestoreUrl = storage.getItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY);
    const currentUrl = getCurrentRelativeUrl();
    if (requestedRestoreUrl === currentUrl) {
      restoreInProgress = true;
      for (const delay of RESTORE_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          restoreCalendarScrollPosition(storage, currentUrl);
        }, delay);
        restoreTimers.push(timer);
      }
      const doneTimer = window.setTimeout(() => {
        restoreInProgress = false;
        if (storage.getItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY) === currentUrl) {
          storage.removeItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY);
        }
        saveCalendarScrollPosition(storage, currentUrl);
      }, Math.max(...RESTORE_DELAYS_MS) + 80);
      restoreTimers.push(doneTimer);
    }

    document.addEventListener("click", handleEventLinkClick, true);
    window.addEventListener("scroll", scheduleSave, { capture: true, passive: true });
    window.addEventListener("pagehide", saveNow);
    document.addEventListener("visibilitychange", saveNow);

    return () => {
      if (saveFrame !== 0) {
        window.cancelAnimationFrame(saveFrame);
      }
      for (const timer of restoreTimers) {
        window.clearTimeout(timer);
      }
      saveNow();
      document.removeEventListener("click", handleEventLinkClick, true);
      window.removeEventListener("scroll", scheduleSave, true);
      window.removeEventListener("pagehide", saveNow);
      document.removeEventListener("visibilitychange", saveNow);
      if (previousScrollRestoration && "scrollRestoration" in window.history) {
        window.history.scrollRestoration = previousScrollRestoration;
      }
    };
  }, []);

  return null;
}

export function EventCalendarBackLink({ children, className, href }: EventCalendarBackLinkProps) {
  const [resolvedHref, setResolvedHref] = useState(href);

  useEffect(() => {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }

    const storedHref = getStoredCalendarReturnHref(storage);
    if (!storedHref) {
      setResolvedHref(href);
      return;
    }

    storage.setItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY, storedHref);
    setResolvedHref(storedHref);
  }, [href]);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }

    const restoreHref = normalizeCalendarHref(resolvedHref) ?? normalizeCalendarHref(href);
    if (!restoreHref) {
      return;
    }

    storage.setItem(CALENDAR_RESTORE_REQUEST_STORAGE_KEY, restoreHref);
  }

  return (
    <Link className={className} href={resolvedHref} onClick={handleClick} prefetch={false} replace>
      {children}
    </Link>
  );
}
