import Image from "next/image";
import Link from "next/link";
import { ExternalLink, Instagram, Search, Sparkles } from "lucide-react";
import {
  EventCategoryPill,
  EventDayPeriodChip,
  EventPriceChip,
} from "@/components/events/event-meta";
import { SaveEventButton } from "@/components/events/save-event-button";
import { ReadMoreText } from "@/components/ui/read-more-text";
import { resolveEventTimeDisplay, type EventDayPeriod } from "@/lib/events/event-time";
import { isApifyImageUrl } from "@/lib/images/apify-images";
import { cn } from "@/lib/utils";

export type DiscoverFeedEvent = {
  _id: string;
  artists: string[];
  date: string;
  eventType: string;
  imageUrl?: string;
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
};

export type DiscoverDateTab = {
  active: boolean;
  href: string;
  label: string;
  sublabel: string;
};

type DiscoverFeedProps = {
  authEnabled: boolean;
  dateTabs: DiscoverDateTab[];
  error?: string;
  events: DiscoverFeedEvent[];
  subline: string;
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

function getAvatarInitial(event: DiscoverFeedEvent): string {
  return (event.instagramHandle || event.venue || event.title).trim().charAt(0).toUpperCase() || "B";
}

function getInstagramHandleLabel(event: DiscoverFeedEvent): string {
  const handle = event.instagramHandle?.replace(/^@/, "").trim();
  if (handle) {
    return `@${handle}`;
  }
  return event.venue;
}

function getStableImageUrl(event: DiscoverFeedEvent): string | null {
  if (event.imageUrl?.startsWith("/api/discover/images/")) {
    return event.imageUrl;
  }
  return isApifyImageUrl(event.imageUrl) ? event.imageUrl : null;
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

function VenueNameLink({
  className,
  event,
}: {
  className?: string;
  event: Pick<DiscoverFeedEvent, "venue" | "venueId">;
}) {
  if (!event.venueId) {
    return <span className={className}>{event.venue}</span>;
  }

  return (
    <Link
      className={cn(className, "hover:text-primary focus-visible:text-primary focus-visible:outline-none")}
      href={`/venues/${event.venueId}`}
      prefetch={false}
    >
      {event.venue}
    </Link>
  );
}

function DiscoverPost({
  authEnabled,
  event,
}: {
  authEnabled: boolean;
  event: DiscoverFeedEvent;
}) {
  const time = getResolvedTime(event);
  const handleLabel = getInstagramHandleLabel(event);
  const instagramCaption = getInstagramCaption(event);
  const imageUrl = getStableImageUrl(event);

  return (
    <article
      className="overflow-hidden rounded-[1.25rem] border border-white/[0.07] bg-[#0d0f16] shadow-[0_26px_70px_-48px_rgba(0,0,0,0.92)]"
      data-discover-post="true"
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            aria-label={`Open ${event.title}`}
            className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full border border-primary/25 bg-primary/[0.14] text-sm font-bold text-primary"
            href={`/events/${event._id}`}
            prefetch={false}
          >
            {getAvatarInitial(event)}
          </Link>
          <span className="min-w-0">
            <Link
              aria-label={`Open ${event.title}`}
              className="block truncate text-sm font-semibold leading-5 text-foreground hover:text-primary"
              href={`/events/${event._id}`}
              prefetch={false}
            >
              {handleLabel}
            </Link>
            <span className="block truncate text-[11px] font-medium text-muted-foreground">
              <VenueNameLink event={event} /> · {formatEventDate(event.date)}
            </span>
          </span>
        </div>
        <span className="inline-flex flex-none items-center rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] font-semibold text-muted-foreground ring-1 ring-white/[0.08]">
          {time.label}
        </span>
      </div>

      {imageUrl ? (
        <Link
          aria-label={`Open ${event.title}`}
          className="relative block aspect-[4/5] overflow-hidden bg-black"
          data-discover-image-source="apify-proxy"
          href={`/events/${event._id}`}
        >
          <Image
            alt={event.title}
            className="object-cover"
            fill
            sizes="(max-width: 768px) 100vw, 38rem"
            src={imageUrl}
            unoptimized
          />
        </Link>
      ) : (
        <div className="border-b border-white/[0.06] bg-black/[0.18] px-4 py-5 sm:px-5">
          <Link aria-label={`Open ${event.title}`} className="block" href={`/events/${event._id}`}>
            <p className="text-xs font-semibold uppercase text-primary">
              {event.title}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Image pending for this post.
            </p>
          </Link>
        </div>
      )}

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
          {authEnabled ? (
            <div data-discover-save-action="true">
              <SaveEventButton
                className="flex-none [&>button]:rounded-full"
                eventId={event._id}
                eventTitle={event.title}
                variant="icon"
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-1">
          {instagramCaption ? (
            <ReadMoreText
              bodyClassName="text-muted-foreground"
              buttonClassName="text-sm leading-6"
              collapsedButtonClassName="bg-[#0d0f16] text-muted-foreground"
              moreLabel="more"
              paragraphProps={{ "data-discover-caption-source": "instagram" }}
              prefix={<span className="font-semibold text-foreground">{handleLabel}</span>}
              text={instagramCaption}
              textClassName="text-sm leading-6 text-foreground"
            />
          ) : (
            <p
              className="text-sm leading-6 text-muted-foreground"
              data-discover-caption-source="missing"
            >
              <span className="font-semibold text-foreground">{handleLabel}</span>{" "}
              caption unavailable from Instagram
            </p>
          )}
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {event.title} · <VenueNameLink event={event} /> · {time.label}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <EventMetaChips event={event} />
          <span className="flex-none text-xs font-semibold text-primary">{time.label}</span>
        </div>
      </div>
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
        {error ? "Discover is quiet right now" : "No picks yet"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {error ?? "Approved events will appear here as soon as they are ready."}
      </p>
    </section>
  );
}

export function DiscoverFeed({
  authEnabled,
  dateTabs,
  error,
  events,
  subline,
}: DiscoverFeedProps) {
  const hasEvents = events.length > 0;

  return (
    <main className="app-page gap-3 sm:gap-4" data-discover-feed="instagram-scroll">
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
          <nav
            aria-label="Discover dates"
            className="mt-4 grid grid-cols-3 gap-1 rounded-full border border-white/[0.07] bg-white/[0.035] p-1"
          >
            {dateTabs.map((tab) => (
              <Link
                aria-current={tab.active ? "date" : undefined}
                className={cn(
                  "min-w-0 rounded-full px-2.5 py-2 text-center",
                  tab.active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
                href={tab.href}
                key={tab.href}
              >
                <span className="block truncate text-xs font-semibold">{tab.label}</span>
                <span className="mt-0.5 block truncate text-[10px] font-medium opacity-75">
                  {tab.sublabel}
                </span>
              </Link>
            ))}
          </nav>
        </header>

        {events.map((event) => (
          <DiscoverPost authEnabled={authEnabled} event={event} key={event._id} />
        ))}
        {!hasEvents || error ? <EmptyDiscoverState error={error} /> : null}
      </div>
    </main>
  );
}
