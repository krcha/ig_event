import type { CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { Search, Sparkles } from "lucide-react";
import { MobileProfileAvatarLink } from "@/components/navigation/mobile-profile-avatar-link";
import {
  EVENT_CATEGORY_TONES,
  EventCategoryPill,
  EventDayPeriodChip,
  EventPriceChip,
  getEventCategoryKind,
} from "@/components/events/event-meta";
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

type DiscoverSectionProps = {
  events: DiscoverFeedEvent[];
  kicker?: string;
  paidLabel?: "Promoted";
  title: string;
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
        <p className={cn("mt-2 line-clamp-4 font-semibold text-foreground", hero ? "text-3xl" : "text-lg")}>
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
  if (!event.imageUrl) {
    return <PosterFallback event={event} hero={hero} />;
  }

  return (
    <Image
      alt={event.title}
      className="object-cover"
      fill
      priority={priority}
      sizes={hero ? "(max-width: 1024px) 100vw, 58rem" : "(max-width: 768px) 70vw, 18rem"}
      src={event.imageUrl}
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

function FeaturedHero({ event }: { event: DiscoverFeedEvent }) {
  const time = getResolvedTime(event);

  return (
    <section className="overflow-hidden rounded-[1.4rem] border border-white/[0.07] bg-[#0d0f16] shadow-[0_38px_98px_-58px_rgba(0,0,0,0.95)]">
      <Link
        aria-label={`Open ${event.title}`}
        className="group grid min-h-[31rem] gap-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]"
        href={`/events/${event._id}`}
      >
        <div className="relative min-h-[31rem] overflow-hidden bg-card">
          <PosterVisual event={event} hero priority />
          <div className="absolute inset-0 bg-gradient-to-t from-black/82 via-black/22 to-black/26" />
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3 sm:p-4">
            <span className="inline-flex items-center rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-[0_18px_40px_-24px_rgba(139,134,251,0.9)]">
              ★ Featured
            </span>
            <span className="inline-flex items-center rounded-full border border-white/[0.14] bg-black/42 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/82 backdrop-blur">
              Sponsored
            </span>
          </div>
          <div className="absolute inset-x-0 bottom-0 space-y-3 p-4 sm:p-5">
            <EventMetaChips event={event} />
            <div>
              <h2 className="text-3xl font-semibold leading-none tracking-tight text-white sm:text-5xl">
                {event.title}
              </h2>
              <p className="mt-3 text-sm font-medium text-white/76 sm:text-base">
                {event.venue} · {time.label}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col justify-end gap-5 border-t border-white/[0.07] bg-[#0d0f16] p-4 sm:p-6 lg:border-l lg:border-t-0">
          <div className="space-y-3">
            <p className="section-kicker text-primary">Featured tonight</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {event.description?.trim() || [formatEventDate(event.date), event.venue].join(" · ")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[1rem] border border-white/[0.06] bg-white/[0.035] px-3 py-3">
              <p className="section-kicker">Date</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{formatEventDate(event.date)}</p>
            </div>
            <div className="rounded-[1rem] border border-white/[0.06] bg-white/[0.035] px-3 py-3">
              <p className="section-kicker">Time</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{time.label}</p>
            </div>
          </div>
        </div>
      </Link>
    </section>
  );
}

function PosterCard({
  event,
  paidLabel,
}: {
  event: DiscoverFeedEvent;
  paidLabel?: "Promoted";
}) {
  const time = getResolvedTime(event);

  return (
    <Link
      aria-label={`Open ${event.title}`}
      className="group block w-[72vw] max-w-[18rem] flex-none sm:w-64"
      href={`/events/${event._id}`}
    >
      <article className="overflow-hidden rounded-[1.15rem] border border-white/[0.07] bg-[#0d0f16] shadow-[0_26px_70px_-48px_rgba(0,0,0,0.9)] transition group-hover:-translate-y-1 group-hover:border-primary/30">
        <div className="relative aspect-[4/5] overflow-hidden bg-card">
          <PosterVisual event={event} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/86 via-black/14 to-black/18" />
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
            <EventCategoryPill className="bg-black/42 backdrop-blur" event={event} />
            {paidLabel ? (
              <span className="inline-flex items-center rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold text-primary-foreground">
                {paidLabel}
              </span>
            ) : null}
          </div>
          <div className="absolute inset-x-0 bottom-0 p-3">
            <p className="line-clamp-2 text-lg font-semibold leading-5 tracking-tight text-white">
              {event.title}
            </p>
            <p className="mt-1 truncate text-xs font-medium text-white/72">
              {event.venue} · {time.label}
            </p>
          </div>
        </div>
        <div className="space-y-2 px-3 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{formatEventDate(event.date)}</span>
            <EventDayPeriodChip value={time.dayPeriod} />
          </div>
          <EventPriceChip value={event.ticketPrice} />
        </div>
      </article>
    </Link>
  );
}

function DiscoverSection({ events, kicker, paidLabel, title }: DiscoverSectionProps) {
  if (events.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {title}
          </h2>
          {kicker ? <p className="mt-1 text-xs font-medium text-muted-foreground">{kicker}</p> : null}
        </div>
      </div>
      <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-2 sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0">
        {events.map((event) => (
          <PosterCard event={event} key={event._id} paidLabel={paidLabel} />
        ))}
      </div>
    </section>
  );
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
  const featured = feed.featured[0];
  const hasSections =
    Boolean(featured) ||
    feed.promoted.length > 0 ||
    feed.tonight.length > 0 ||
    feed.weekend.length > 0 ||
    feed.free.length > 0;

  return (
    <main className="app-page app-page-wide gap-4 sm:gap-5">
      <header className="hero-panel px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="section-kicker">Poster-led picks</p>
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
            <MobileProfileAvatarLink />
          </div>
        </div>
      </header>

      {featured ? <FeaturedHero event={featured} /> : null}
      <DiscoverSection
        events={feed.promoted}
        kicker="Paid placements"
        paidLabel="Promoted"
        title="Promoted"
      />
      <DiscoverSection events={feed.tonight} title="Tonight's picks" />
      <DiscoverSection events={feed.weekend} title="This weekend" />
      <DiscoverSection events={feed.free} title="Free entry" />
      {!hasSections || error ? <EmptyDiscoverState error={error} /> : null}
    </main>
  );
}
