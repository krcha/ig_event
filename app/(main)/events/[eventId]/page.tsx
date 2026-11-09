import { getLocale as getMetadataLocale } from "@/i18n/server";
import { localizedMetadata, SITE_COPY, formatSeoDate } from "@/lib/i18n/seo";
import { getEventContentLocales, getLocalizedEventDescription } from "@/lib/i18n/event-content";
import { localizeHref, LOCALE_LANGUAGE_TAGS } from "@/i18n/config";
import { publicText } from "@/lib/i18n/public-messages";
import { formatPublicDate } from "@/lib/i18n/display";

import { LocalizedElement, PublicText } from "@/components/i18n/public-text";
import type { Metadata } from "next";
import { LocalizedLink as Link } from "@/components/i18n/public-text";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
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
import { EventCategoryPill, EventMetaRow, EventPriceChip, EventSecondaryTags } from "@/components/events/event-meta";
import { EventSessionLabel } from "@/components/events/event-session-label";
import { EventCalendarBackLink } from "@/components/calendar/calendar-scroll-restoration";
import { ReadMoreText } from "@/components/ui/read-more-text";
import { JsonLd } from "@/components/seo/json-ld";
import {
  resolveEventTimeDisplay,
  type EventDayPeriod,
  type EventTimeDisplaySource,
  type EventTimeStatus,
} from "@/lib/events/event-time";
import { resolveEventTimePresentation } from "@/lib/events/event-time-presentation";
import { SaveEventButton } from "@/components/events/save-event-button";
import { EventShareButton } from "@/components/events/event-share-button";
import { ResponsiveEventImage } from "@/components/events/responsive-event-image";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { VenueWeeklyHours } from "@/components/venues/venue-weekly-hours";
import { cn } from "@/lib/utils";
import { loadPublicEventDetailData } from "@/lib/events/public-event-detail-data";
import {
  projectPublicEventVenueDisplay,
  sanitizeVenueLinkedPublicEventFields,
} from "@/lib/events/public-event-venue-fields";
import {
  getPublicReviewedSourceUpdate,
  type ReviewedSourceUpdate,
} from "@/lib/events/reviewed-source-update";
import {
  buildDiscoverImageUrl,
  hasDiscoverImageSource,
} from "@/lib/discover/discover-image-source";
import { isPlausibleConvexPublicId } from "@/lib/convex/public-id";
import {
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueName,
  normalizeHandle,
  toSearchableText,
} from "@/lib/pipeline/venue-normalization";

import {
  absoluteUrl,
  buildBreadcrumbStructuredData,
  buildEventStructuredData,
  clipText,
} from "@/lib/seo/site";

import type { ConfirmedEventSchemaFacts } from "@/lib/events/confirmed-event-schema-facts";
import type { VenueHoursCacheFields } from "@/lib/venues/venue-hours-cache";

export const revalidate = 60;

type EventRecord = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  timeStatus?: EventTimeStatus | null;
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
  artistDisplayCredits?: string[];
  description?: string;
  reviewedSourceUpdate?: ReviewedSourceUpdate;
  sourceCaption?: string;
  structuredDataFacts?: ConfirmedEventSchemaFacts;
  imageUrl?: string;
  imageStorageId?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
  updatedAt?: number;
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
  aliases?: string[];
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
    for (const name of [venue.name, ...(venue.aliases ?? [])]) {
      const nameKey = normalizeVenueLookupKey(name);
      if (nameKey && !venuesByName.has(nameKey)) {
        venuesByName.set(nameKey, venue);
      }
    }
    const handleKey = normalizeHandle(venue.instagramHandle);
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

const loadEvent = cache(async function loadEvent(eventId: string): Promise<EventRecord | null> {
  if (!isPlausibleConvexPublicId(eventId)) {
    return null;
  }

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
    ? venues.find((candidate) => candidate._id === event.venueId)
    : findVenueForEvent(event, venues);
  const displayTime = resolveEventTimeDisplay({
    date: event.date,
    time: event.time,
    venueHours: venue,
  });
  event.dayPeriod = displayTime.dayPeriod;
  event.displayTimeEnd = displayTime.endLabel;
  event.displayTimeLabel = displayTime.label;
  event.displayTimeSource = displayTime.source;
  event.displayTimeStart = displayTime.startLabel;
  event.venueCategory = venue?.category ?? event.venueCategory ?? undefined;
  const publicEvent = projectPublicEventVenueDisplay(event, venue);
  if (!event.venueId || venue?._id !== event.venueId) {
    publicEvent.structuredDataFacts = undefined;
  }
  // The public venue query fails closed. Never retain the denormalized ID
  // when the referenced venue is pending or hidden.
  publicEvent.venueId = venue?._id;
  publicEvent.venueHours = venue
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
  return sanitizeVenueLinkedPublicEventFields(publicEvent, Boolean(venue));
});

function buildCalendarHref(event: EventRecord): string {
  const month = event.date.slice(0, 7);
  const query = new URLSearchParams({ month, day: event.date });
  return `/?${query.toString()}`;
}

function buildStableEventImageUrl(event: EventRecord): string | null {
  if (!hasDiscoverImageSource(event)) {
    return null;
  }

  return absoluteUrl(buildDiscoverImageUrl(event));
}

export async function generateMetadata({ params }: EventDetailPageProps): Promise<Metadata> {
  const locale = await getMetadataLocale();
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) notFound();
  const date = formatSeoDate(event.date, locale);
  const title = `${event.title} — ${event.venue}, ${SITE_COPY[locale].belgrade}`;
  const description = {
    sr: `${event.title} — ${event.venue}, ${date}. Najavljeno vreme, izvođači i originalna objava događaja.`,
    en: `${event.title} at ${event.venue} on ${date}. Announced time, artists and the original event announcement.`,
    ru: `${event.title} — ${event.venue}, ${date}. Объявленное время, участники и исходный анонс события.`,
  }[locale];
  return localizedMetadata({ locale, path: `/events/${event._id}`, title: clipText(title, 90), description: clipText(description, 180), type: "article", image: buildStableEventImageUrl(event), readyLocales: getEventContentLocales(event) });
}

function InfoTile({
  detail,
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  detail?: ReactNode;
  icon: typeof CalendarDays;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
      <p className="section-kicker"><PublicText text={label} /></p>
      <p className={cn("mt-1.5 flex items-start gap-2 text-sm font-semibold leading-5 text-foreground", valueClassName)}>
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
  version,
}: {
  alt: string;
  className?: string;
  priority?: boolean;
  sizes: string;
  src: string;
  version?: string | number;
}) {
  return (
    <ResponsiveEventImage
      alt={alt}
      className={className}
      fill
      priority={priority}
      sizes={sizes}
      src={src}
      version={version}
    />
  );
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const locale = await getMetadataLocale();
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) {
    notFound();
  }
  const artistCredits = event.artistDisplayCredits ?? event.artists;
  const eventTime = resolveEventTimePresentation(event);
  const preferredText = event.sourceCaption?.trim() || event.description?.trim() || "";
  const localizedDescription = getLocalizedEventDescription({ ...event, description: preferredText }, locale);
  const whatToKnowText = localizedDescription.text;
  const reviewedSourceUpdate = getPublicReviewedSourceUpdate(event);
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const venueHref = event.venueId ? `/venues/${event.venueId}` : null;
  const calendarHref = buildCalendarHref(event);
  const eventImageUrl = hasDiscoverImageSource(event)
    ? buildDiscoverImageUrl(event)
    : null;
  const breadcrumbItems = [
    { name: "Belgrade events", path: "/" },
    ...(venueHref ? [{ name: event.venue, path: venueHref }] : []),
    { name: event.title, path: `/events/${event._id}` },
  ];
  const eventSchema = buildEventStructuredData({
    _id: event._id,
    date: event.date,
    imageUrl: buildStableEventImageUrl(event) ?? undefined,
    structuredDataFacts: event.structuredDataFacts,
    title: event.title,
    venue: event.venue,
    venueId: event.venueId,
    venueLatitude: event.venueLatitude,
    venueLocation: event.venueLocation,
    venueLongitude: event.venueLongitude,
  }, locale);

  return (
    <main className="app-page gap-3 pb-[calc(9.5rem+env(safe-area-inset-bottom))] md:pb-9">
      {eventSchema ? <JsonLd data={eventSchema} /> : null}
      <JsonLd data={buildBreadcrumbStructuredData(breadcrumbItems, locale)} />
      <LocalizedElement as="nav" aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Link className="hover:text-primary" href="/"><PublicText text={"Belgrade events"} /></Link>
        <span aria-hidden="true">/</span>
        {venueHref ? (
          <>
            <Link className="min-w-0 truncate hover:text-primary" href={venueHref}>{event.venue}</Link>
            <span aria-hidden="true">/</span>
          </>
        ) : null}
        <span aria-current="page" className="min-w-0 truncate text-foreground">{event.title}</span>
      </LocalizedElement>
      <div className="flex items-center justify-between gap-3">
        <EventCalendarBackLink className="button-secondary min-h-10 gap-2 px-4 py-0" href={calendarHref}>
          <ArrowLeft className="h-4 w-4" /><PublicText text={"Back"} /></EventCalendarBackLink>
        <EventShareButton eventId={event._id} title={event.title} url={absoluteUrl(localizeHref(`/events/${event._id}`, locale))} />
        {event?.status && event.status !== "approved" ? (
          <span className="app-chip bg-card/95">{event.status}</span>
        ) : null}
      </div>

      <article className="hero-panel overflow-hidden">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
              <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6 lg:px-7">
                <div className="flex flex-wrap gap-2">
                  <EventCategoryPill className="text-xs" event={event} />
                  <EventSecondaryTags className="text-xs" event={event} />
                  <EventPriceChip className="text-xs" value={event.ticketPrice} />
                </div>

                <div className="space-y-2">
                  <p className="section-kicker"><PublicText text={"Event details"} /></p>
                  <h1 className="text-2xl font-semibold leading-tight tracking-[-0.045em] sm:text-4xl lg:text-5xl">
                    {event.title}
                  </h1>
                  <EventSessionLabel className="text-sm sm:text-base" event={event} />
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <InfoTile icon={CalendarDays} label={publicText(locale, "Date")} value={formatPublicDate(locale, event.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} />
                  <InfoTile
                    icon={Clock3}
                    label={publicText(locale, eventTime.heading)}
                    value={publicText(locale, eventTime.label)}
                    valueClassName={eventTime.kind === "venue_hours" ? "font-normal" : undefined}
                  />
                  <div className="relative overflow-hidden rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3 transition hover:border-primary/35 hover:bg-white/[0.045]">
                    {venueHref ? (
                      <Link
                        aria-label={`Open ${event.venue}`}
                        className="absolute inset-0 z-0 rounded-[1rem]"
                        href={venueHref}
                        prefetch={false}
                      >
                        <span className="sr-only"><PublicText text={"Open "} />{event.venue}</span>
                      </Link>
                    ) : null}
                    <p className="pointer-events-none relative z-10 section-kicker"><PublicText text={"Venue"} /></p>
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
                    {event.venueLocation ? (
                      <p
                        className="pointer-events-none relative z-10 mt-1.5 break-words pl-6 text-xs leading-5 text-muted-foreground"
                        data-event-venue-address="true"
                      >
                        {event.venueLocation}
                      </p>
                    ) : null}
                    <EventMetaRow className="pointer-events-none relative z-10 mt-2 pl-6" event={event} />
                  </div>
                </div>

                {whatToKnowText || reviewedSourceUpdate ? (
                  <section className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
                    <p className="text-sm font-semibold text-foreground"><PublicText text={"What to know"} /></p>
                    {reviewedSourceUpdate ? (
                      <p className="mt-2 text-sm leading-6 text-muted-foreground" data-reviewed-source-update="true">
                        <span className="font-semibold text-foreground"><PublicText text={"Update:"} /></span>{" "}
                        {reviewedSourceUpdate.text}{" "}
                        <LocalizedElement as="a"
                          className="font-semibold text-primary hover:text-primary/85"
                          href={reviewedSourceUpdate.sourceUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                        ><PublicText text={"View post"} /></LocalizedElement>
                      </p>
                    ) : null}
                    {whatToKnowText ? (
                      <>
                      {localizedDescription.original ? <p className="mt-2 text-xs text-muted-foreground"><PublicText text={event.sourceCaption?.trim() ? "Original caption" : "Original description"} /></p> : null}
                      <ReadMoreText
                        buttonClassName="text-sm leading-6 text-primary hover:text-primary/85"
                        className="mt-2"
                        collapsedButtonClassName="bg-[#10141F]"
                        lessLabel={publicText(locale, "show less")}
                        moreLabel={publicText(locale, "read more")}
                        paragraphProps={{ "data-event-description": "true", lang: localizedDescription.original ? "und" : LOCALE_LANGUAGE_TAGS[locale] }}
                        text={whatToKnowText}
                        textClassName="text-sm leading-6 text-muted-foreground"
                      />
                      </>
                    ) : null}
                  </section>
                ) : null}

                {artistCredits.length > 0 ? (
                  <details className="group rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-2.5">
                    <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                      <span><PublicText text={"Artists"} /></span>
                      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        {event.artistDisplayCredits ? null : event.artists.length}
                        <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
                      </span>
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {artistCredits.map((artist) => (
                        <span className="app-chip bg-card/95" key={artist}>
                          {artist}
                        </span>
                      ))}
                    </div>
                  </details>
                ) : null}

                <div className="hidden flex-wrap gap-2 md:flex">
                  <SaveEventButton event={event} eventId={event._id} eventTitle={event.title} variant="full" />
                  {event.instagramPostUrl ? (
                    <LocalizedElement as="a"
                      aria-label={`View post: original Instagram announcement for ${event.title}`}
                      className="button-primary gap-2"
                      href={event.instagramPostUrl}
                      rel="noreferrer"
                      target="_blank"
                    ><PublicText text={"View post"} /><ExternalLink className="h-4 w-4" />
                    </LocalizedElement>
                  ) : null}
                  <EventCalendarBackLink className="button-secondary gap-2" href={calendarHref}>
                    <CalendarDays className="h-4 w-4" /><PublicText text={"Calendar"} /></EventCalendarBackLink>
                </div>
              </div>

              <aside className="border-t border-border/75 bg-muted/[0.22] p-3 sm:p-5 lg:border-l lg:border-t-0">
                {eventImageUrl ? (
                  <div className="overflow-hidden rounded-[1.1rem] border border-border/75 bg-card p-1.5 shadow-[0_24px_68px_-48px_rgba(0,0,0,0.82)]">
                    <div className="relative aspect-[16/10] max-h-64 w-full overflow-hidden rounded-[0.9rem] lg:aspect-[4/5] lg:max-h-none">
                    <EventImage
                      alt={event.title}
                      className="object-contain"
                      priority
                      sizes="(max-width: 1024px) 100vw, 352px"
                      src={eventImageUrl}
                      version={event.imageStorageId || event.updatedAt}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-40 items-center justify-center rounded-[1.1rem] border border-dashed border-border/80 bg-card/82 px-6 text-center text-sm text-muted-foreground lg:min-h-72"><PublicText text={"No poster image available."} /></div>
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
                <SaveEventButton
                  className="min-w-0 flex-1 [&>button]:w-full [&>button]:px-3"
                  event={event}
                  eventId={event._id}
                  eventTitle={event.title}
                  variant="full"
                />
              {event.instagramPostUrl ? (
                <LocalizedElement as="a"
                  aria-label={`View post: original Instagram announcement for ${event.title}`}
                  className="button-primary min-h-11 flex-1 gap-2 px-3 py-0"
                  href={event.instagramPostUrl}
                  rel="noreferrer"
                  target="_blank"
                ><PublicText text={"View post"} /><ExternalLink className="h-4 w-4" />
                </LocalizedElement>
              ) : null}
              <EventCalendarBackLink className="button-secondary min-h-11 flex-1 gap-2 px-3 py-0" href={calendarHref}>
                <CalendarDays className="h-4 w-4" /><PublicText text={"Calendar"} /></EventCalendarBackLink>
            </div>
          </div>
    </main>
  );
}
