"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Instagram, Search, Sparkles } from "lucide-react";
import {
  EventCategoryPill,
  EventDayPeriodChip,
  EventPriceChip,
} from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { resolveEventTimeDisplay, type EventDayPeriod } from "@/lib/events/event-time";
import { getEventSessionLabel } from "@/lib/events/event-session";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";
import { MobileDiscover } from "./mobile-discover";
import type { MobileDiscoverEvent } from "@/lib/discover/mobile-event";
import { EventZekaMark } from "@/components/brand/event-zeka-brand";
import styles from "./desktop-discover.module.css";

export type DiscoverFeedEvent = {
  _id: string;
  artists: string[];
  date: string;
  description?: string;
  displayTimeLabel?: string;
  timeStatus?: string;
  eventType: string;
  imageUrl?: string;
  imageStorageId?: string;
  instagramHandle?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  ticketPrice?: string;
  time?: string;
  title: string;
  venue: string;
  venueId?: string;
  venueHours?: VenueHoursCacheFields;
};

export type DiscoverDateTab = {
  active: boolean;
  href: string;
  label: string;
  sublabel: string;
};

type DiscoverPagination = {
  currentPage: number;
  firstEventNumber: number;
  lastEventNumber: number;
  nextHref?: string;
  previousHref?: string;
  totalEvents: number;
  totalPages: number;
};

type DiscoverFeedProps = {
  authEnabled: boolean;
  dateTabs: DiscoverDateTab[];
  error?: string;
  events: DiscoverFeedEvent[];
  introduction: string;
  pagination: DiscoverPagination;
  revision: string;
  selectedDate: string;
  subline: string;
  mobileEvents: MobileDiscoverEvent[];
  today: string;
};

type DiscoverBatchResponse = {
  date?: string;
  events?: DiscoverFeedEvent[];
  hasMore?: boolean;
  nextCursor?: string | null;
};

function getResolvedTime(event: DiscoverFeedEvent): {
  dayPeriod: EventDayPeriod;
  label: string;
} {
  const displayTime = resolveEventTimeDisplay({
    date: event.date,
    time: event.time,
  });
  return {
    dayPeriod: displayTime.dayPeriod,
    label: displayTime.label,
  };
}

function formatEventDate(value: string): string {
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) {
    return value;
  }

  const date = new Date(
    Date.UTC(
      Number.parseInt(parts[1], 10),
      Number.parseInt(parts[2], 10) - 1,
      Number.parseInt(parts[3], 10),
      12,
    ),
  );

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Belgrade",
    weekday: "short",
  }).format(date);
}

function getInstagramHandleLabel(event: DiscoverFeedEvent): string {
  const handle = event.instagramHandle?.replace(/^@/, "").trim();
  if (handle) {
    return `@${handle}`;
  }
  return event.venue;
}

function getStableImageUrl(event: DiscoverFeedEvent): string | null {
  return event.imageUrl?.startsWith("/api/discover/images/") ? event.imageUrl : null;
}

function EventMetaChips({ event }: { event: DiscoverFeedEvent }) {
  const time = getResolvedTime(event);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <EventCategoryPill className="flex-none" event={event} />
      <EventDayPeriodChip className="flex-none" value={time.dayPeriod} />
      <EventPriceChip className="flex-none" value={event.ticketPrice} />
    </div>
  );
}

function getInstagramCaption(event: DiscoverFeedEvent): string | null {
  return event.sourceCaption?.trim() || null;
}

function DiscoverPost({ event }: { event: DiscoverFeedEvent }) {
  const [imageFailed, setImageFailed] = useState(false);
  const time = getResolvedTime(event);
  const handleLabel = getInstagramHandleLabel(event);
  const instagramCaption = getInstagramCaption(event);
  const imageUrl = getStableImageUrl(event);
  const sessionLabel = getEventSessionLabel(event);

  return (
    <article className={styles.post} data-discover-post="true" aria-label={event.title}>
      <Link aria-label={`Open details for ${event.title}`} className={styles.posterLink} href={`/events/${event._id}`} prefetch={false}>
        {imageUrl && !imageFailed ? <Image alt={event.title} className={styles.poster} data-discover-image-source="event-proxy" fill loading="lazy" onError={() => setImageFailed(true)} sizes="(max-width: 1024px) 25vw, (max-width: 1536px) 24vw, 350px" src={imageUrl} unoptimized /> : <span className={styles.missingImage}><Sparkles aria-hidden="true" size={30} /><span>{event.title}</span><span>{imageFailed ? "Poster unavailable." : "Image pending for this post."}</span></span>}
        <div className={styles.overlay} data-discover-hover-details="true">
          <div className={styles.eventInfo}>
            <span className={styles.eventTime}>{formatEventDate(event.date)} · {time.label}</span>
            <h2>{event.title}</h2>
            {sessionLabel ? <p className={styles.sessionLabel}>{sessionLabel}</p> : null}
            <p className={styles.eventVenue}>{event.venue}</p>
            <EventMetaChips event={event} />
            {instagramCaption ? <p className={styles.caption} data-discover-caption-source="instagram">{instagramCaption}</p> : <p className={styles.caption} data-discover-caption-source="missing">{handleLabel} · caption unavailable from Instagram</p>}
            <span className={styles.openDetails}>Event details <ExternalLink aria-hidden="true" size={14} /></span>
          </div>
        </div>
      </Link>
      <div className={styles.saveAction} data-discover-save-action="true"><SaveEventButton eventId={event._id} event={event} eventTitle={event.title} variant="icon" /></div>
      {event.instagramPostUrl ? <a aria-label={`Open ${event.title} on Instagram`} className={styles.sourceAction} href={event.instagramPostUrl} rel="noreferrer" target="_blank"><Instagram aria-hidden="true" size={16} /></a> : null}
    </article>
  );
}

function EmptyDiscoverState({ error }: { error?: string }) {
  return (
    <section className="rounded-[1.25rem] border border-dashed border-border/80 bg-card/70 px-4 py-10 text-center sm:px-6">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">
        {error ? "Events could not load" : "No events for this date"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {error ?? "Try another date or browse the calendar."}
      </p>
    </section>
  );
}

export function DiscoverFeed(props: DiscoverFeedProps) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    update(); media.addEventListener("change",update);
    return () => media.removeEventListener("change",update);
  }, []);
  if (mobile) return <MobileDiscover authEnabled={props.authEnabled} error={props.error} events={props.mobileEvents} selectedDate={props.selectedDate} today={props.today} />;
  return <div className="hidden md:block"><DesktopDiscoverFeed {...props} /></div>;
}

function DesktopDiscoverFeed({
  dateTabs,
  error,
  events,
  introduction,
  pagination,
  revision,
  selectedDate,
  subline,
}: DiscoverFeedProps) {
  const [visibleEvents, setVisibleEvents] = useState(events);
  const [nextCursor, setNextCursor] = useState<string | null>(events.at(-1)?._id ?? null);
  const [hasMore, setHasMore] = useState(Boolean(pagination.nextHref && events.length > 0));
  const [nextPage, setNextPage] = useState(pagination.currentPage + 1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ message: string; reload: boolean } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const hasEvents = visibleEvents.length > 0;
  const fallbackHref = `/discover?date=${encodeURIComponent(selectedDate)}&page=${nextPage}`;
  const reloadHref = `/discover?date=${encodeURIComponent(selectedDate)}`;

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || inFlight.current) {
      return;
    }

    inFlight.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const query = new URLSearchParams({ date: selectedDate, after: nextCursor, revision });
      const response = await fetch(`/api/discover/posts?${query}`, { cache: "no-store" });
      const batch = (await response.json()) as DiscoverBatchResponse;
      if (!response.ok) {
        if (response.status === 409) {
          setLoadError({ message: "The feed changed. Reload this day to continue.", reload: true });
          return;
        }
        throw new Error("Could not load more posts.");
      }
      if (
        batch.date !== selectedDate ||
        !Array.isArray(batch.events) ||
        typeof batch.hasMore !== "boolean" ||
        (batch.hasMore && batch.events.length === 0) ||
        (batch.hasMore && (!batch.nextCursor || batch.nextCursor === nextCursor))
      ) {
        throw new Error("Could not load more posts.");
      }

      const incomingEvents = batch.events;
      setVisibleEvents((previous) => {
        const seen = new Set(previous.map((event) => event._id));
        return [...previous, ...incomingEvents.filter((event) => !seen.has(event._id))];
      });
      setNextCursor(batch.nextCursor ?? null);
      setHasMore(batch.hasMore);
      setNextPage((page) => page + 1);
    } catch (caught) {
      setLoadError({
        message: caught instanceof Error ? caught.message : "Could not load more posts.",
        reload: false,
      });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [hasMore, nextCursor, revision, selectedDate]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loadError || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadError, loadMore]);

  return (
    <main className="app-page app-page-wide gap-3 sm:gap-4" data-discover-feed="instagram-profile">
      <div className="mx-auto flex w-full max-w-[88rem] flex-col gap-3 sm:gap-4">
        <header>
          <div className={styles.profile}>
            <div className={styles.avatar}><EventZekaMark /></div>
            <div className={styles.profileCopy}>
              <div className={styles.profileTitle}><h1>Discover Belgrade</h1><span className={styles.count}><strong>{pagination.totalEvents}</strong> events</span></div>
              <p className={styles.subline}>{subline}</p>
              <p className={styles.intro}>{introduction}</p>
            </div>
            <Link aria-label="Search events" className={styles.search} href="/"><Search aria-hidden="true" size={18} /></Link>
          </div>
          <nav aria-label="Discover dates" className={styles.dates}>
            {dateTabs.map(tab => <a aria-current={tab.active ? "date" : undefined} className={styles.date} href={tab.href} key={tab.href}><strong>{tab.label}</strong><span>{tab.sublabel}</span></a>)}
          </nav>
        </header>

        <section
          className={styles.grid}
          data-discover-post-grid="true"
        >
          {visibleEvents.map((event) => (
            <DiscoverPost event={event} key={event._id} />
          ))}
        </section>
        {hasMore ? (
          <div
            className="mx-auto flex w-full max-w-[38rem] flex-col items-center gap-2 py-3 lg:max-w-none"
            data-discover-pagination="infinite"
            ref={sentinelRef}
          >
            {loading ? (
              <p aria-live="polite" className="text-xs text-muted-foreground">Loading more posts…</p>
            ) : loadError ? (
              <div className="flex flex-col items-center gap-2 text-center">
                <p aria-live="polite" className="text-xs text-muted-foreground">{loadError.message}</p>
                {loadError.reload ? (
                  <a className="button-secondary min-h-10 px-4 py-0" href={reloadHref}>Reload this day</a>
                ) : (
                  <>
                    <button className="button-secondary min-h-10 px-4 py-0" onClick={() => void loadMore()} type="button">
                      Retry
                    </button>
                    <a className="text-xs text-primary underline" href={fallbackHref}>Open next page</a>
                  </>
                )}
              </div>
            ) : (
              <a className="button-secondary min-h-10 px-4 py-0" href={fallbackHref}>
                More picks
              </a>
            )}
          </div>
        ) : null}
        {pagination.previousHref ? (
          <a className="sr-only focus:not-sr-only" href={pagination.previousHref}>Previous page</a>
        ) : null}
        {!hasEvents || error ? <EmptyDiscoverState error={error} /> : null}
      </div>
    </main>
  );
}
