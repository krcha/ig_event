import type { CSSProperties } from "react";
import Link from "next/link";
import { ExternalLink, Instagram, Search, Sparkles } from "lucide-react";
import { PosterImage } from "@/components/discover/poster-image";
import {
  EVENT_CATEGORY_TONES,
  EventCategoryPill,
  EventDayPeriodChip,
  EventPriceChip,
  getEventCategoryKind,
} from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { resolveEventTimeDisplay, type EventDayPeriod } from "@/lib/events/event-time";
import { cn } from "@/lib/utils";

type PromotionTier = "featured" | "promoted";

export type DiscoverFeedEvent = {
  _id: string;
  artists: string[];
  date: string;
  description?: string;
  eventType: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  promotionEnd?: string;
  promotionPriority?: number;
  promotionStart?: string;
  promotionTier?: PromotionTier;
  ticketPrice?: string;
  time?: string;
  title: string;
  venue: string;
};

export type DiscoverFeedData = {
  featured: DiscoverFeedEvent[];
  free: DiscoverFeedEvent[];
  promoted: DiscoverFeedEvent[];
  tonight: DiscoverFeedEvent[];
  weekend: DiscoverFeedEvent[];
};

type DiscoverFeedProps = {
  error?: string;
  feed: DiscoverFeedData;
  subline: string;
};

type DiscoverFeedItem = {
  event: DiscoverFeedEvent;
  featured?: boolean;
  label: string;
  paidLabel?: "Featured" | "Promoted";
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

function getPosterStyle(event: DiscoverFeedEvent): CSSProperties {
  const tone = EVENT_CATEGORY_TONES[getEventCategoryKind(event)];
  return {
    backgroundColor: tone.backgroundColor,
    borderColor: `${tone.color}44`,
    color: tone.color,
  };
}

function getAvatarInitial(event: DiscoverFeedEvent): string {
  return (event.venue || event.title).trim().charAt(0).toUpperCase() || "B";
}

function shouldBypassImageOptimizer(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith("cdninstagram.com") || host.endsWith("fbcdn.net");
  } catch {
    return false;
  }
}

function PosterFallback({ event, hero = false }: { event: DiscoverFeedEvent; hero?: boolean }) {
  const tone = EVENT_CATEGORY_TONES[getEventCategoryKind(event)];

  return (
    <div
      className={cn(
        "flex h-full w-full items-end overflow-hidden border bg-card px-4 py-4",
        hero ? "rounded-[1.25rem]" : "rounded-[1rem]",
      )}
      style={getPosterStyle(event)}
    >
      <div className="min-w-0">
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.24em]"
          style={{ color: tone.color }}
        >
          {tone.label}
        </p>
        <p
          className={cn(
            "mt-2 line-clamp-4 font-semibold text-foreground",
            hero ? "text-3xl" : "text-lg",
          )}
        >
          {event.title}
        </p>
      </div>
    </div>
  );
}

function PosterVisual({
  event,
  hero = false,
  priority = false,
}: {
  event: DiscoverFeedEvent;
  hero?: boolean;
  priority?: boolean;
}) {
  const fallback = <PosterFallback event={event} hero={hero} />;

  if (!event.imageUrl) {
    return fallback;
  }

  return (
    <PosterImage
      alt={event.title}
      className="object-cover"
      fallback={fallback}
      fill
      priority={priority}
      sizes="(max-width: 768px) 100vw, 38rem"
      src={event.imageUrl}
      unoptimized={shouldBypassImageOptimizer(event.imageUrl)}
    />
  );
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

function DiscoverPost({ item }: { item: DiscoverFeedItem }) {
  const { event } = item;
  const time = getResolvedTime(event);
  const tone = EVENT_CATEGORY_TONES[getEventCategoryKind(event)];
  const description = event.description?.trim();

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[1.25rem] border border-white/[0.07] bg-[#0d0f16] shadow-[0_26px_70px_-48px_rgba(0,0,0,0.92)]",
        item.featured && "border-primary/24 shadow-[0_34px_90px_-54px_rgba(139,134,251,0.72)]",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-3">
        <Link
          aria-label={`Open ${event.title}`}
          className="flex min-w-0 items-center gap-3"
          href={`/events/${event._id}`}
        >
          <span
            className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full border text-sm font-bold"
            style={{
              backgroundColor: tone.backgroundColor,
              borderColor: `${tone.color}55`,
              color: tone.color,
            }}
          >
            {getAvatarInitial(event)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-5 text-foreground">
              {event.venue}
            </span>
            <span className="block truncate text-[11px] font-medium text-muted-foreground">
              {item.label} · {formatEventDate(event.date)}
            </span>
          </span>
        </Link>
        {item.paidLabel ? (
          <span className="inline-flex flex-none items-center rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground">
            {item.paidLabel}
          </span>
        ) : null}
      </div>

      <Link
        aria-label={`Open ${event.title}`}
        className="group relative block aspect-[4/5] overflow-hidden bg-card"
        href={`/events/${event._id}`}
      >
        <PosterVisual event={event} hero={item.featured} priority={item.featured} />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-black/8 opacity-85 transition group-hover:opacity-100" />
      </Link>

      <div className="space-y-3 px-3 pb-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {event.instagramPostUrl ? (
              <a
                aria-label={`Open ${event.title} on Instagram`}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.035] text-muted-foreground hover:border-primary/35 hover:bg-primary/[0.12] hover:text-primary"
                href={event.instagramPostUrl}
                rel="noreferrer"
                target="_blank"
              >
                <Instagram className="h-4 w-4" />
              </a>
            ) : null}
            <Link
              aria-label={`Open details for ${event.title}`}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.035] text-muted-foreground hover:border-primary/35 hover:bg-primary/[0.12] hover:text-primary"
              href={`/events/${event._id}`}
            >
              <ExternalLink className="h-4 w-4" />
            </Link>
          </div>
          <SaveEventButton
            className="flex-none [&>button]:rounded-full"
            eventId={event._id}
            eventTitle={event.title}
            variant="icon"
          />
        </div>

        <Link aria-label={`Open ${event.title}`} className="block" href={`/events/${event._id}`}>
          <p className="line-clamp-3 text-sm leading-6 text-foreground">
            <span className="font-semibold">{event.title}</span>
            {description ? (
              <span className="text-muted-foreground"> {description}</span>
            ) : (
              <span className="text-muted-foreground"> at {event.venue}</span>
            )}
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {event.venue} · {time.label}
          </p>
        </Link>

        <div className="flex items-center justify-between gap-3">
          <EventMetaChips event={event} />
          <span className="flex-none text-xs font-semibold text-primary">{time.label}</span>
        </div>
      </div>
    </article>
  );
}

function buildDiscoverFeedItems(feed: DiscoverFeedData): DiscoverFeedItem[] {
  const items: DiscoverFeedItem[] = [];
  const seenEventIds = new Set<string>();

  function append(
    events: DiscoverFeedEvent[],
    label: string,
    options: Pick<DiscoverFeedItem, "featured" | "paidLabel"> = {},
  ) {
    for (const event of events) {
      if (seenEventIds.has(event._id)) {
        continue;
      }
      seenEventIds.add(event._id);
      items.push({
        event,
        label,
        ...options,
      });
    }
  }

  append(feed.featured, "Featured tonight", {
    featured: true,
    paidLabel: "Featured",
  });
  append(feed.promoted, "Promoted", { paidLabel: "Promoted" });
  append(feed.tonight, "Tonight's picks");
  append(feed.weekend, "This weekend");
  append(feed.free, "Free entry");

  return items;
}

function EmptyDiscoverState({ error }: { error?: string }) {
  return (
    <section className="rounded-[1.25rem] border border-dashed border-border/80 bg-card/70 px-4 py-10 text-center sm:px-6">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">
        {error ? "Discover is quiet right now" : "No picks yet"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {error ?? "Approved events will appear here as soon as they are ready."}
      </p>
    </section>
  );
}

export function DiscoverFeed({ error, feed, subline }: DiscoverFeedProps) {
  const feedItems = buildDiscoverFeedItems(feed);
  const hasSections = feedItems.length > 0;

  return (
    <main className="app-page gap-3 sm:gap-4">
      <div className="mx-auto flex w-full max-w-[38rem] flex-col gap-3 sm:gap-4">
        <header className="px-1 py-1 sm:px-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="section-kicker">Belgrade feed</p>
              <h1 className="mt-2 text-3xl font-semibold leading-none tracking-tight text-foreground sm:text-5xl">
                Discover
              </h1>
              <p className="mt-2 text-sm font-medium text-muted-foreground">{subline}</p>
            </div>
            <div className="flex flex-none items-center gap-2">
              <Link
                aria-label="Search events"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-muted-foreground ring-1 ring-white/[0.08] hover:bg-primary/[0.16] hover:text-primary"
                href="/"
              >
                <Search className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </header>

        {feedItems.map((item) => (
          <DiscoverPost item={item} key={`${item.label}-${item.event._id}`} />
        ))}
        {!hasSections || error ? <EmptyDiscoverState error={error} /> : null}
      </div>
    </main>
  );
}
