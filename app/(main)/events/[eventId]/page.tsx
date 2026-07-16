import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  Clock3,
  ExternalLink,
  MapPin,
} from "lucide-react";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { EventCategoryPill, EventMetaRow, EventPriceChip } from "@/components/events/event-meta";
import { EventCalendarBackLink } from "@/components/calendar/calendar-scroll-restoration";
import { ReadMoreText } from "@/components/ui/read-more-text";
import {
  UNKNOWN_EVENT_TIME_LABEL,
  getDisplayEventTime,
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
} from "@/lib/events/event-time";
import { SaveEventButton } from "@/components/events/save-event-button";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { VenueWeeklyHours } from "@/components/venues/venue-weekly-hours";
import { loadPublicEventDetailData } from "@/lib/events/public-event-detail-data";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
} from "@/lib/taxonomy/venue-types";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  normalizeHandle,
  toSearchableText,
} from "@/lib/pipeline/venue-normalization";
import { isApifyImageUrl } from "@/lib/images/apify-images";
import { cn } from "@/lib/utils";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";

export const revalidate = 60;

type EventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  dayPeriod?: EventDayPeriod;
  displayTimeEnd?: string;
  displayTimeLabel?: string;
  displayTimeSource?: EventTimeDisplaySource;
  displayTimeStart?: string;
  venue: string;
  venueCategory?: string;
  venueHours?: VenueHoursCacheFields;
  venueId?: string;
  venueInstagramHandle?: string;
  venueLatitude?: number;
  venueLocation?: string;
  venueLongitude?: number;
  artists: string[];
  description?: string;
  sourceCaption?: string;
  imageUrl?: string;
  instagramPostUrl?: string;
  ticketPrice?: string;
  attendance?: number | string;
  attendanceCount?: number | string;
  attendeeCount?: number | string;
  attendees?: number | string;
  attendeesCount?: number | string;
  going?: number | string;
  goingCount?: number | string;
  eventType: string;
  status: "pending" | "approved" | "rejected";
};

type VenueRecord = {
  _id: string;
  name: string;
  instagramHandle: string;
  category?: string | null;
  googlePlaceId?: string | null;
  hoursError?: string | null;
  hoursExpiresAt?: number | null;
  hoursFetchedAt?: number | null;
  hoursJson?: string | null;
  hoursSource?: "osm" | "google" | "manual" | "none" | null;
  hoursTimezone?: string | null;
  latitude?: number | null;
  location?: string | null;
  longitude?: number | null;
  neighborhood?: string | null;
  osmElementId?: string | null;
  osmElementType?: string | null;
};

type EventDetailPageProps = {
  params: Promise<{ eventId: string }>;
};

const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
const listPublicVenueFieldsByIdsQuery =
  "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;
const listPublicActiveVenueFieldsQuery =
  "venues:listPublicActiveVenueFields" as unknown as FunctionReference<"query">;

function normalizeVenueLookupKey(value: string | null | undefined): string {
  return toSearchableText(value ?? "");
}

function findVenueForEvent(event: EventRecord, venues: VenueRecord[]): VenueRecord | undefined {
  const venuesByName = new Map<string, VenueRecord>();
  const venuesByHandle = new Map<string, VenueRecord>();
  for (const venue of venues) {
    const nameKey = normalizeVenueLookupKey(venue.name);
    const handleKey = normalizeHandle(venue.instagramHandle);
    if (nameKey && !venuesByName.has(nameKey)) {
      venuesByName.set(nameKey, venue);
    }
    if (handleKey && !venuesByHandle.has(handleKey)) {
      venuesByHandle.set(handleKey, venue);
    }
  }

  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(
    venues.filter((venue) => venue.instagramHandle),
  );
  const canonicalVenueName = canonicalizeVenueName(event.venue, canonicalVenueNamesByHandle);
  return (
    venuesByHandle.get(normalizeHandle(event.venueInstagramHandle ?? "")) ??
    venuesByName.get(normalizeVenueLookupKey(event.venue)) ??
    (canonicalVenueName
      ? venuesByName.get(normalizeVenueLookupKey(canonicalVenueName))
      : undefined)
  );
}

async function loadEvent(eventId: string): Promise<EventRecord | null> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("Convex is not configured yet.");
  }

  const convex = new ConvexHttpClient(convexUrl);
  const { event, venues } = await loadPublicEventDetailData<EventRecord, VenueRecord>({
    loadEvent: () => convex.query(getPublicApprovedEventQuery, { id: eventId }) as Promise<EventRecord | null>,
    loadVenues: (loadedEvent) =>
      loadedEvent.venueId
        ? (convex.query(listPublicVenueFieldsByIdsQuery, {
            ids: [loadedEvent.venueId],
          }) as Promise<VenueRecord[]>)
        : (convex.query(listPublicActiveVenueFieldsQuery, {
            limit: 1000,
          }) as Promise<VenueRecord[]>),
  });
  if (!event) {
    return null;
  }

  const venue = event.venueId
    ? venues[0] ?? findVenueForEvent(event, venues)
    : findVenueForEvent(event, venues);
  const canonicalEventType = canonicalizeEventType(event.eventType);
  const displayTime = resolveEventTimeDisplay({
    date: event.date,
    time: event.time,
    venueHours: venue,
  });
  event.eventType =
    canonicalEventType === DEFAULT_EVENT_TYPE
      ? eventTypeFromVenueCategory(venue?.category ?? event.venueCategory)
      : canonicalEventType;
  event.dayPeriod = displayTime.dayPeriod;
  event.displayTimeEnd = displayTime.endLabel;
  event.displayTimeLabel = displayTime.label;
  event.displayTimeSource = displayTime.source;
  event.displayTimeStart = displayTime.startLabel;
  event.venueCategory = venue?.category ?? event.venueCategory ?? undefined;
  // The public venue query fails closed. Never retain the denormalized ID
  // when the referenced venue is pending or hidden.
  event.venueId = venue?._id;
  event.venueHours = venue
    ? {
        googlePlaceId: venue.googlePlaceId ?? null,
        hoursError: venue.hoursError ?? null,
        hoursExpiresAt: venue.hoursExpiresAt ?? null,
        hoursFetchedAt: venue.hoursFetchedAt ?? null,
        hoursJson: venue.hoursJson ?? null,
        hoursSource: venue.hoursSource ?? null,
        hoursTimezone: venue.hoursTimezone ?? null,
        osmElementId: venue.osmElementId ?? null,
        osmElementType: venue.osmElementType ?? null,
      }
    : undefined;
  return event;
}

function formatEventDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function buildCalendarHref(event: EventRecord): string {
  const month = event.date.slice(0, 7);
  const query = new URLSearchParams({ month, day: event.date });
  return `/?${query.toString()}`;
}

function InfoTile({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail?: ReactNode;
  icon: typeof CalendarDays;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
      <p className="section-kicker">{label}</p>
      <p className="mt-1.5 flex items-start gap-2 text-sm font-semibold leading-5 text-foreground">
        <Icon className="mt-0.5 h-4 w-4 flex-none text-primary" />
        <span className="min-w-0 break-words">{value}</span>
      </p>
      {detail}
    </div>
  );
}

function EventImage({
  alt,
  className,
  priority = false,
  sizes,
  src,
}: {
  alt: string;
  className?: string;
  priority?: boolean;
  sizes: string;
  src: string;
}) {
  if (isApifyImageUrl(src)) {
    return (
      <Image
        alt={alt}
        className={className}
        fill
        priority={priority}
        sizes={sizes}
        src={src}
      />
    );
  }

  return (
    <img
      alt={alt}
      className={cn("absolute inset-0 h-full w-full", className)}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      src={src}
    />
  );
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) {
    notFound();
  }
  const eventTime =
    event.displayTimeLabel ?? getDisplayEventTime(event.time) ?? UNKNOWN_EVENT_TIME_LABEL;
  const whatToKnowText = event.sourceCaption?.trim() || event.description?.trim() || "";
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const venueHref = event.venueId ? `/venues/${event.venueId}` : null;
  const calendarHref = buildCalendarHref(event);

  return (
    <main className="app-page gap-3 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-9">
      <div className="flex items-center justify-between gap-3">
        <EventCalendarBackLink className="button-secondary min-h-10 gap-2 px-4 py-0" href={calendarHref}>
          <ArrowLeft className="h-4 w-4" />
          Back
        </EventCalendarBackLink>
        {event?.status && event.status !== "approved" ? (
          <span className="app-chip bg-card/95">{event.status}</span>
        ) : null}
      </div>

      <article className="hero-panel overflow-hidden">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
              <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6 lg:px-7">
                <div className="flex flex-wrap gap-2">
                  <EventCategoryPill className="text-xs" event={event} />
                  <EventPriceChip className="text-xs" value={event.ticketPrice} />
                </div>

                <div className="space-y-2">
                  <p className="section-kicker">Event details</p>
                  <h1 className="text-2xl font-semibold leading-tight tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                    {event.title}
                  </h1>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <InfoTile icon={CalendarDays} label="Date" value={formatEventDate(event.date)} />
                  {eventTime ? (
                    <InfoTile
                      icon={Clock3}
                      label="Time"
                      value={eventTime}
                    />
                  ) : null}
                  <div className="relative overflow-hidden rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3 transition hover:border-primary/35 hover:bg-white/[0.045]">
                    {venueHref ? (
                      <Link
                        aria-label={`Open ${event.venue}`}
                        className="absolute inset-0 z-0 rounded-[1rem]"
                        href={venueHref}
                        prefetch={false}
                      >
                        <span className="sr-only">Open {event.venue}</span>
                      </Link>
                    ) : null}
                    <p className="pointer-events-none relative z-10 section-kicker">Venue</p>
                    <p className="pointer-events-none relative z-10 mt-1.5 flex items-start gap-2 text-sm font-semibold leading-5 text-foreground">
                      <MapPin className="mt-0.5 h-4 w-4 flex-none text-primary" />
                      <span className="min-w-0 flex-1 break-words">{event.venue}</span>
                      {authEnabled && event.venueId ? (
                        <FavoriteVenueButton
                          className="pointer-events-auto relative z-20 -mt-1"
                          venueId={event.venueId}
                          venueName={event.venue}
                        />
                      ) : null}
                    </p>
                    <EventMetaRow className="pointer-events-none relative z-10 mt-2 pl-6" event={event} />
                  </div>
                </div>

                {whatToKnowText ? (
                  <section className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
                    <p className="text-sm font-semibold text-foreground">What to know</p>
                    <ReadMoreText
                      buttonClassName="text-sm leading-6 text-primary hover:text-primary/85"
                      className="mt-2"
                      collapsedButtonClassName="bg-[#0d0f16]"
                      lessLabel="show less"
                      moreLabel="read more"
                      paragraphProps={{ "data-event-description": "true" }}
                      text={whatToKnowText}
                      textClassName="text-sm leading-6 text-muted-foreground"
                    />
                  </section>
                ) : null}

                {event.artists.length > 0 ? (
                  <details className="group rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-2.5">
                    <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                      <span>Artists</span>
                      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        {event.artists.length}
                        <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                      </span>
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {event.artists.map((artist) => (
                        <span className="app-chip bg-card/95" key={artist}>
                          {artist}
                        </span>
                      ))}
                    </div>
                  </details>
                ) : null}

                <div className="hidden flex-wrap gap-2 md:flex">
                  {authEnabled ? (
                    <SaveEventButton eventId={event._id} eventTitle={event.title} variant="full" />
                  ) : null}
                  {event.instagramPostUrl ? (
                    <a
                      className="button-primary gap-2"
                      href={event.instagramPostUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Instagram
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  ) : null}
                  <EventCalendarBackLink className="button-secondary gap-2" href={calendarHref}>
                    <CalendarDays className="h-4 w-4" />
                    Calendar
                  </EventCalendarBackLink>
                </div>
              </div>

              <aside className="border-t border-border/75 bg-muted/[0.22] p-3 sm:p-5 lg:border-l lg:border-t-0">
                {event.imageUrl ? (
                  <div className="overflow-hidden rounded-[1.1rem] border border-border/75 bg-card p-1.5 shadow-[0_24px_68px_-48px_rgba(0,0,0,0.82)]">
                    <div className="relative aspect-[16/10] max-h-64 w-full overflow-hidden rounded-[0.9rem] lg:aspect-[4/5] lg:max-h-none">
                    <EventImage
                      alt={event.title}
                      className="object-cover"
                      priority
                      sizes="(max-width: 1024px) 100vw, 352px"
                      src={event.imageUrl}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-40 items-center justify-center rounded-[1.1rem] border border-dashed border-border/80 bg-card/82 px-6 text-center text-sm text-muted-foreground lg:min-h-72">
                    No poster image available.
                  </div>
                )}
              </aside>
            </div>
          </article>

          <VenueWeeklyHours
            hoursJson={event.venueHours?.hoursJson}
            hoursSource={event.venueHours?.hoursSource}
          />

          <div className="fixed inset-x-0 bottom-[calc(4.85rem+env(safe-area-inset-bottom))] z-40 px-3 md:hidden">
            <div className="glass-panel flex gap-2 bg-card/95 p-2 shadow-[0_-18px_48px_-34px_rgba(0,0,0,0.9)]">
              {authEnabled ? (
                <SaveEventButton
                  className="min-w-0 flex-1 [&>button]:w-full [&>button]:px-3"
                  eventId={event._id}
                  eventTitle={event.title}
                  variant="full"
                />
              ) : null}
              {event.instagramPostUrl ? (
                <a
                  className="button-primary min-h-11 flex-1 gap-2 px-3 py-0"
                  href={event.instagramPostUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Instagram
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
              <EventCalendarBackLink className="button-secondary min-h-11 flex-1 gap-2 px-3 py-0" href={calendarHref}>
                <CalendarDays className="h-4 w-4" />
                Calendar
              </EventCalendarBackLink>
            </div>
          </div>
    </main>
  );
}
