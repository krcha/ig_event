import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { ReadMoreText } from "@/components/ui/read-more-text";
import {
  getDisplayEventTime,
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
} from "@/lib/events/event-time";
import { SaveEventButton } from "@/components/events/save-event-button";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { VenueWeeklyHours } from "@/components/venues/venue-weekly-hours";
import {
  DEFAULT_EVENT_TYPE,
  canonicalizeEventType,
  eventTypeFromVenueCategory,
} from "@/lib/taxonomy/venue-types";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";

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
  params: { eventId: string };
};

const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;
const listPublicVenueFieldsByIdsQuery =
  "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;
const listPublicActiveVenueFieldsQuery =
  "venues:listPublicActiveVenueFields" as unknown as FunctionReference<"query">;

function normalizeVenueLookupKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findVenueForEvent(event: EventRecord, venues: VenueRecord[]): VenueRecord | undefined {
  const venueNameKey = normalizeVenueLookupKey(event.venue);
  const venueHandleKey = normalizeVenueLookupKey(event.venueInstagramHandle);

  return venues.find((venue) => {
    if (venueNameKey && normalizeVenueLookupKey(venue.name) === venueNameKey) {
      return true;
    }
    return venueHandleKey && normalizeVenueLookupKey(venue.instagramHandle) === venueHandleKey;
  });
}

async function loadEvent(eventId: string): Promise<{
  event: EventRecord | null;
  error?: string;
}> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return { event: null, error: "Convex is not configured yet." };
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    const event = (await convex.query(getPublicApprovedEventQuery, { id: eventId })) as EventRecord | null;
    if (event) {
      const venues = event.venueId
        ? ((await convex.query(listPublicVenueFieldsByIdsQuery, {
            ids: [event.venueId],
          })) as VenueRecord[])
        : ((await convex.query(listPublicActiveVenueFieldsQuery, {
            limit: 1000,
          })) as VenueRecord[]);
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
      event.venueId = event.venueId ?? venue?._id;
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
    }
    return { event };
  } catch (error) {
    return {
      event: null,
      error: error instanceof Error ? error.message : "Failed to load event details.",
    };
  }
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
  icon: Icon,
  label,
  value,
}: {
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
    </div>
  );
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { event, error } = await loadEvent(params.eventId);
  if (!event && !error) {
    notFound();
  }
  const eventTime = event ? event.displayTimeLabel ?? getDisplayEventTime(event.time) : undefined;
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <main className="app-page gap-3 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-9">
      <div className="flex items-center justify-between gap-3">
        <Link className="button-secondary min-h-10 gap-2 px-4 py-0" href="/">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        {event?.status && event.status !== "approved" ? (
          <span className="app-chip bg-card/95">{event.status}</span>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {event ? (
        <>
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
                  {eventTime ? <InfoTile icon={Clock3} label="Time" value={eventTime} /> : null}
                  <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
                    <p className="section-kicker">Venue</p>
                    <p className="mt-1.5 flex items-start gap-2 text-sm font-semibold leading-5 text-foreground">
                      <MapPin className="mt-0.5 h-4 w-4 flex-none text-primary" />
                      {event.venueId ? (
                        <Link
                          className="min-w-0 flex-1 break-words hover:text-primary"
                          href={`/venues/${event.venueId}`}
                        >
                          {event.venue}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 break-words">{event.venue}</span>
                      )}
                      {authEnabled ? (
                        <FavoriteVenueButton
                          className="-mt-1"
                          venueId={event.venueId}
                          venueName={event.venue}
                        />
                      ) : null}
                    </p>
                    <EventMetaRow className="mt-2 pl-6" event={event} />
                  </div>
                </div>

                {event.description ? (
                  <section className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
                    <p className="text-sm font-semibold text-foreground">What to know</p>
                    <ReadMoreText
                      buttonClassName="text-sm leading-6 text-primary hover:text-primary/85"
                      className="mt-2"
                      collapsedButtonClassName="bg-[#0d0f16]"
                      lessLabel="show less"
                      moreLabel="read more"
                      paragraphProps={{ "data-event-description": "true" }}
                      text={event.description}
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
                  <Link className="button-secondary gap-2" href={buildCalendarHref(event)}>
                    <CalendarDays className="h-4 w-4" />
                    Calendar
                  </Link>
                </div>
              </div>

              <aside className="border-t border-border/75 bg-muted/[0.22] p-3 sm:p-5 lg:border-l lg:border-t-0">
                {event.imageUrl ? (
                  <div className="overflow-hidden rounded-[1.1rem] border border-border/75 bg-card p-1.5 shadow-[0_24px_68px_-48px_rgba(0,0,0,0.82)]">
                    <div className="relative aspect-[16/10] max-h-64 w-full overflow-hidden rounded-[0.9rem] lg:aspect-[4/5] lg:max-h-none">
                      <Image
                        alt={event.title}
                        className="object-cover"
                        fill
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
              <Link className="button-secondary min-h-11 flex-1 gap-2 px-3 py-0" href={buildCalendarHref(event)}>
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
            </div>
          </div>
        </>
      ) : (
        <div className="glass-panel px-6 py-10 text-center">
          <p className="text-base font-semibold text-foreground">Event not found.</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            It may have been removed or has not been approved yet.
          </p>
          <Link className="button-primary mt-5" href="/">
            Browse events
          </Link>
        </div>
      )}
    </main>
  );
}
