"use client";
import { LocalizedElement } from "@/components/i18n/public-text";

import { PublicText } from "@/components/i18n/public-text";


import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import type { PublicEventPostPreview } from "@/lib/events/public-event-post";
import { cn } from "@/lib/utils";

let previewModule: Promise<typeof import("./event-post-preview")> | null = null;
function loadEventPostPreview() {
  previewModule ??= import("./event-post-preview").catch((cause: unknown) => {
    previewModule = null;
    throw cause;
  });
  return previewModule;
}
function warmEventPostPreview() { void loadEventPostPreview().catch(() => {}); }
const EventPostPreview = lazy(loadEventPostPreview);
const PREVIEW_CACHE_LIMIT = 12;
const PREVIEW_CACHE_TTL_MS = 60_000;

type PreviewContextValue = {
  activeId: string | null;
  close: (eventId: string) => void;
  load: (eventId: string, signal: AbortSignal) => Promise<PublicEventPostPreview>;
  toggle: (eventId: string, anchor: HTMLButtonElement) => void;
};

const PreviewContext = createContext<PreviewContextValue | null>(null);

export function CalendarEventPreviews({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const cache = useRef(new Map<string, { expiresAt: number; post: PublicEventPostPreview }>());
  const anchor = useRef<{ element: HTMLButtonElement; top: number } | null>(null);

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /^(slow-)?2g$/u.test(connection?.effectiveType ?? "")) return;
    let timer: number | null = null;
    let idle: number | null = null;
    const schedule = () => {
      timer = window.setTimeout(() => {
        timer = null;
        if ("requestIdleCallback" in window) idle = window.requestIdleCallback(() => {
          idle = null;
          if (!document.hidden) warmEventPostPreview();
        }, { timeout: 1_500 });
        else if (!document.hidden) warmEventPostPreview();
      }, 750);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      window.removeEventListener("load", schedule);
      if (timer !== null) window.clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
    };
  }, []);

  const toggle = useCallback((eventId: string, element: HTMLButtonElement) => {
    anchor.current = { element, top: element.getBoundingClientRect().top };
    setActiveId((current) => current === eventId ? null : eventId);
  }, []);

  const close = useCallback((eventId: string) => {
    setActiveId((current) => current === eventId ? null : current);
  }, []);

  useLayoutEffect(() => {
    const previous = anchor.current;
    anchor.current = null;
    if (!previous?.element.isConnected) return;

    // Closing a post above the clicked row must not move that row out from
    // under the user's pointer. Native scroll anchoring may already do this.
    const delta = previous.element.getBoundingClientRect().top - previous.top;
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: "instant" });
  }, [activeId]);

  const load = useCallback(async (eventId: string, signal: AbortSignal) => {
    const cached = cache.current.get(eventId);
    if (cached && cached.expiresAt > Date.now()) return cached.post;

    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/post`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 404
        ? "This post is no longer available."
        : "The post could not be loaded. Please try again.");
    }
    const post: PublicEventPostPreview = await response.json();
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    if (post.eventId !== eventId) throw new Error("The post could not be loaded. Please try again.");

    cache.current.delete(eventId);
    cache.current.set(eventId, { expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS, post });
    if (cache.current.size > PREVIEW_CACHE_LIMIT) {
      const oldest = cache.current.keys().next().value;
      if (oldest !== undefined) cache.current.delete(oldest);
    }
    return post;
  }, []);

  const value = useMemo(() => ({ activeId, close, load, toggle }), [activeId, close, load, toggle]);
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function useCalendarEventPreview() {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("Calendar event previews require their provider.");
  return value;
}

export function CalendarEventPreviewRow({
  children,
  eventId,
  headerClassName,
  title,
  venueHoursLabel,
  venueLatitude,
  venueLongitude,
  venueName,
}: {
  children: ReactNode;
  eventId: string;
  headerClassName?: string;
  title: string;
  venueHoursLabel?: string | null;
  venueLatitude?: number;
  venueLongitude?: number;
  venueName?: string;
}) {
  const { activeId, close, toggle } = useCalendarEventPreview();
  const trigger = useRef<HTMLButtonElement>(null);
  const open = activeId === eventId;
  const panelId = `calendar-post-${eventId}`;
  const triggerId = `calendar-post-toggle-${eventId}`;

  const closePost = () => {
    close(eventId);
    trigger.current?.focus({ preventScroll: true });
  };

  return (
    <div className="relative" data-calendar-event-preview-row="true" data-expanded={open ? "true" : "false"}>
      <div
        className={cn("relative rounded-[inherit] transition-colors", open && "bg-primary/[0.05]")}
        data-calendar-event-preview-header="true"
      >
        <LocalizedElement as="button"
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} Instagram post for ${title}`}
          className="absolute inset-0 z-0 scroll-mt-44 cursor-pointer rounded-[inherit] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          data-calendar-event-preview-toggle={eventId}
          id={triggerId}
          onClick={(event) => toggle(eventId, event.currentTarget)}
          onFocus={warmEventPostPreview}
          onPointerDown={warmEventPostPreview}
          onPointerEnter={warmEventPostPreview}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) closePost();
          }}
          ref={trigger}
          type="button"
        />
        <div className={cn(
          "pointer-events-none relative flex min-w-0 items-center gap-2 [&_a]:pointer-events-auto [&_button]:pointer-events-auto",
          headerClassName,
        )}>
          {children}
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 flex-none text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180 text-primary")}
          />
        </div>
      </div>
      <div aria-labelledby={triggerId} hidden={!open} id={panelId} role="region">
        {open ? (
          <Suspense fallback={<CalendarPostLoading />}>
            <EventPostPreview eventId={eventId} onClose={closePost} title={title} venueHoursLabel={venueHoursLabel}
              venueLatitude={venueLatitude} venueLongitude={venueLongitude} venueName={venueName} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}

function CalendarPostLoading() {
  return (
    <div className="border-t border-border/75 bg-[#10141F] p-3" role="status">
      <div className="h-[min(38svh,18rem)] min-h-48 rounded-lg bg-white/[0.035] motion-safe:animate-pulse" />
      <p className="mt-2 text-xs text-muted-foreground"><PublicText text={"Loading Instagram post..."} /></p>
    </div>
  );
}
