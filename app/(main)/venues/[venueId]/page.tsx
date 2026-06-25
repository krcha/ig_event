import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ExternalLink,
  Heart,
  History,
  Instagram,
  MapPin,
  MessageCircle,
  Radio,
  Route,
  Sparkles,
  Users,
} from "lucide-react";
import {
  EventCategoryPill,
  EventMetaRow,
  EventPriceChip,
} from "@/components/events/event-meta";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { VenueWeeklyHours } from "@/components/venues/venue-weekly-hours";
import {
  loadPublicVenuePage,
  type PublicInstagramPost,
  type PublicVenue,
  type PublicVenueEvent,
} from "@/lib/venues/public-venue-pages";
import { getDisplayEventTime } from "@/lib/events/event-time";
import { cn } from "@/lib/utils";

export const revalidate = 60;

type VenuePageProps = {
  params: { venueId: string };
};

type IconComponent = typeof CalendarDays;

function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Not captured";
  }

  return new Intl.NumberFormat("en-US", {
    compactDisplay: "short",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(value);
}

function formatEventDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function formatPostDate(post: PublicInstagramPost): string {
  const timestamp = post.postedAtMs ?? (post.postedAt ? Date.parse(post.postedAt) : NaN);
  if (!Number.isFinite(timestamp)) {
    return "Recent";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function formatVenueCategory(value: string | null | undefined): string {
  return value?.trim() || "Venue";
}

function getLocationLabel(venue: PublicVenue): string {
  return [venue.location, venue.neighborhood].filter(Boolean).join(", ") || "Belgrade";
}

function getDirectionsHref(venue: PublicVenue): string {
  if (typeof venue.latitude === "number" && typeof venue.longitude === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${venue.name} ${getLocationLabel(venue)}`,
  )}`;
}

function getOpenStreetMapEmbedUrl(venue: PublicVenue): string | null {
  if (typeof venue.latitude !== "number" || typeof venue.longitude !== "number") {
    return null;
  }

  const lat = venue.latitude;
  const lon = venue.longitude;
  const deltaLat = 0.004;
  const deltaLon = 0.006;
  const bbox = [
    lon - deltaLon,
    lat - deltaLat,
    lon + deltaLon,
    lat + deltaLat,
  ].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(
    bbox,
  )}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lon}`)}`;
}

function getInstagramHref(venue: PublicVenue): string {
  return (
    venue.instagramProfileUrl ||
    `https://www.instagram.com/${venue.instagramHandle.replace(/^@+/, "")}/`
  );
}

function VenueMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: IconComponent;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
      <p className="section-kicker">{label}</p>
      <p className="mt-2 flex items-center gap-2 text-lg font-semibold leading-6 text-foreground">
        <Icon className="h-4 w-4 flex-none text-primary" />
        <span className="min-w-0 break-words">{value}</span>
      </p>
    </div>
  );
}

function VenueMapPanel({ venue }: { venue: PublicVenue }) {
  const embedUrl = getOpenStreetMapEmbedUrl(venue);
  const directionsHref = getDirectionsHref(venue);

  return (
    <section className="overflow-hidden rounded-[1rem] border border-border/75 bg-white/[0.025]">
      {embedUrl ? (
        <iframe
          className="h-64 w-full border-0 sm:h-72 lg:h-full"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          src={embedUrl}
          title={`${venue.name} map`}
        />
      ) : (
        <div className="flex min-h-64 items-center justify-center bg-muted/30 px-6 text-center">
          <div>
            <MapPin className="mx-auto h-7 w-7 text-primary" />
            <p className="mt-3 text-sm font-semibold text-foreground">
              {getLocationLabel(venue)}
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 border-t border-border/75 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="section-kicker">Location</p>
          <p className="mt-1 text-sm font-medium leading-5 text-foreground">
            {getLocationLabel(venue)}
          </p>
        </div>
        <a className="button-secondary min-h-10 gap-2 px-4 py-0" href={directionsHref} target="_blank" rel="noreferrer">
          <Route className="h-4 w-4" />
          Directions
        </a>
      </div>
    </section>
  );
}

function VenueEventCard({
  event,
  tone = "default",
}: {
  event: PublicVenueEvent;
  tone?: "default" | "quiet";
}) {
  const eventTime = event.displayTimeLabel ?? getDisplayEventTime(event.time);

  return (
    <Link
      className={cn(
        "group flex min-w-0 gap-3 rounded-[1rem] border border-border/75 bg-white/[0.025] p-2.5 transition hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/[0.045]",
        tone === "quiet" && "bg-card/55",
      )}
      href={`/events/${event._id}`}
      prefetch={false}
    >
      <div className="relative h-24 w-20 flex-none overflow-hidden rounded-[0.85rem] border border-border/75 bg-card sm:h-28 sm:w-24">
        {event.imageUrl ? (
          <Image
            alt={event.title}
            className="object-cover transition duration-300 group-hover:scale-105"
            fill
            sizes="96px"
            src={event.imageUrl}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-primary">
            <CalendarDays className="h-6 w-6" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 py-1">
        <div className="flex flex-wrap gap-1.5">
          <EventCategoryPill event={event} />
          <EventPriceChip value={event.ticketPrice} />
        </div>
        <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-foreground sm:text-base">
          {event.title}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-muted-foreground">
          {formatEventDate(event.date)}
          {eventTime ? ` - ${eventTime}` : ""}
        </p>
        <EventMetaRow className="mt-1.5" event={event} />
      </div>
    </Link>
  );
}

function InstagramPostCard({ post }: { post: PublicInstagramPost }) {
  return (
    <a
      className="group overflow-hidden rounded-[1rem] border border-border/75 bg-white/[0.025] transition hover:-translate-y-0.5 hover:border-primary/35"
      href={post.instagramPostUrl}
      rel="noreferrer"
      target="_blank"
    >
      <div className="relative aspect-square bg-card">
        {post.imageUrl ? (
          <Image
            alt="Recent Instagram post"
            className="object-cover transition duration-300 group-hover:scale-105"
            fill
            sizes="(max-width: 640px) 33vw, 160px"
            src={post.imageUrl}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-primary">
            <Instagram className="h-6 w-6" />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground">
        <span>{formatPostDate(post)}</span>
        <ExternalLink className="h-3.5 w-3.5" />
      </div>
    </a>
  );
}

function SectionHeader({
  action,
  eyebrow,
  title,
}: {
  action?: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="section-kicker">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-semibold leading-7 text-foreground sm:text-2xl">
          {title}
        </h2>
      </div>
      {action}
    </div>
  );
}

export async function generateMetadata({ params }: VenuePageProps): Promise<Metadata> {
  const { upcomingEvents, venue } = await loadPublicVenuePage(params.venueId, {
    historyLimit: 3,
    upcomingLimit: 3,
  });

  if (!venue) {
    return {
      title: "Venue not found - Belgrade nights",
    };
  }

  const description = [
    `${venue.name} in Belgrade`,
    upcomingEvents.length > 0
      ? `${upcomingEvents.length} upcoming approved event${upcomingEvents.length === 1 ? "" : "s"}`
      : "upcoming events, hours, location, and Instagram identity",
  ]
    .filter(Boolean)
    .join(" - ");
  const image = upcomingEvents.find((event) => event.imageUrl)?.imageUrl;

  return {
    title: `${venue.name} - Belgrade venue events`,
    description,
    openGraph: {
      title: `${venue.name} - Belgrade venue events`,
      description,
      ...(image ? { images: [image] } : {}),
      type: "website",
    },
  };
}

export default async function VenuePage({ params }: VenuePageProps) {
  const { error, historyEvents, recentInstagramPosts, stats, upcomingEvents, venue } =
    await loadPublicVenuePage(params.venueId);

  if (!venue && !error) {
    notFound();
  }

  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const instagramHref = venue ? getInstagramHref(venue) : "";
  const locationLabel = venue ? getLocationLabel(venue) : "";
  const followerLabel = formatCompactNumber(venue?.instagramFollowerCount);
  const appFollowerLabel = formatCompactNumber(stats?.appFollowerCount ?? 0);

  return (
    <main className="app-page gap-4 pb-[calc(7rem+env(safe-area-inset-bottom))] md:pb-9">
      <div className="flex items-center justify-between gap-3">
        <Link className="button-secondary min-h-10 gap-2 px-4 py-0" href="/venues">
          <ArrowLeft className="h-4 w-4" />
          Venues
        </Link>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {venue ? (
        <>
          <article className="hero-panel overflow-hidden">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)]">
              <div className="space-y-5 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="app-chip bg-primary/[0.14] text-primary">
                    {formatVenueCategory(venue.category)}
                  </span>
                  <span className="app-chip bg-card/95">
                    <Instagram className="h-3.5 w-3.5" />
                    @{venue.instagramHandle}
                  </span>
                </div>

                <div>
                  <p className="section-kicker">Venue</p>
                  <h1 className="mt-2 text-3xl font-semibold leading-tight text-foreground sm:text-5xl">
                    {venue.name}
                  </h1>
                  <p className="mt-3 flex max-w-2xl items-start gap-2 text-sm leading-6 text-muted-foreground sm:text-base">
                    <MapPin className="mt-1 h-4 w-4 flex-none text-primary" />
                    <span>{locationLabel}</span>
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  {authEnabled ? (
                    <FavoriteVenueButton
                      className="[&>button]:min-h-11"
                      venueId={venue._id}
                      venueName={venue.name}
                      variant="full"
                    />
                  ) : null}
                  <a
                    className="button-primary min-h-11 gap-2 px-4 py-0"
                    href={instagramHref}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <Instagram className="h-4 w-4" />
                    Instagram
                  </a>
                  <a
                    className="button-secondary min-h-11 gap-2 px-4 py-0"
                    href={getDirectionsHref(venue)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <Route className="h-4 w-4" />
                    Map
                  </a>
                </div>

                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <VenueMetric icon={Users} label="Instagram followers" value={followerLabel} />
                  <VenueMetric icon={Heart} label="App followers" value={appFollowerLabel} />
                  <VenueMetric
                    icon={CalendarDays}
                    label="Upcoming"
                    value={String(stats?.approvedUpcomingCount ?? upcomingEvents.length)}
                  />
                  <VenueMetric
                    icon={Sparkles}
                    label="Recent momentum"
                    value={`${stats?.recentApprovedCount ?? 0}/${stats?.recentWindowDays ?? 30}d`}
                  />
                </div>
              </div>

              <div className="border-t border-border/75 bg-muted/[0.18] p-3 sm:p-5 lg:border-l lg:border-t-0">
                <VenueMapPanel venue={venue} />
              </div>
            </div>
          </article>

          <section className="space-y-3">
            <SectionHeader
              eyebrow="Upcoming"
              title={`${venue.name} events`}
              action={
                upcomingEvents.length > 0 ? (
                  <Link className="button-secondary min-h-10 gap-2 px-4 py-0" href={`/?venue=${encodeURIComponent(venue.name)}`}>
                    <CalendarDays className="h-4 w-4" />
                    Calendar
                  </Link>
                ) : null
              }
            />
            {upcomingEvents.length > 0 ? (
              <div className="grid gap-2 lg:grid-cols-2">
                {upcomingEvents.map((event) => (
                  <VenueEventCard event={event} key={event._id} />
                ))}
              </div>
            ) : (
              <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
                <CalendarDays className="mx-auto h-7 w-7 text-primary" />
                <p className="mt-3 text-sm font-semibold text-foreground">
                  No approved upcoming events yet.
                </p>
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <VenueWeeklyHours
              hoursJson={venue.hoursJson}
              hoursSource={venue.hoursSource}
            />

            <section className="space-y-3">
              <SectionHeader eyebrow="History" title="Recent approved nights" />
              {historyEvents.length > 0 ? (
                <div className="grid gap-2">
                  {historyEvents.map((event) => (
                    <VenueEventCard event={event} key={event._id} tone="quiet" />
                  ))}
                </div>
              ) : (
                <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
                  <History className="mx-auto h-7 w-7 text-primary" />
                  <p className="mt-3 text-sm font-semibold text-foreground">
                    No approved history is available.
                  </p>
                </div>
              )}
            </section>
          </div>

          <section className="space-y-3">
            <SectionHeader
              eyebrow="Social"
              title="Recent Instagram activity"
              action={
                <a
                  className="button-secondary min-h-10 gap-2 px-4 py-0"
                  href={instagramHref}
                  rel="noreferrer"
                  target="_blank"
                >
                  <MessageCircle className="h-4 w-4" />
                  @{venue.instagramHandle}
                </a>
              }
            />
            {recentInstagramPosts.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {recentInstagramPosts.map((post) => (
                  <InstagramPostCard key={post._id} post={post} />
                ))}
              </div>
            ) : (
              <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
                <Radio className="mx-auto h-7 w-7 text-primary" />
                <p className="mt-3 text-sm font-semibold text-foreground">
                  Recent Instagram posts will appear after the next scrape.
                </p>
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="glass-panel px-6 py-10 text-center">
          <p className="text-base font-semibold text-foreground">Venue not found.</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            It may have been removed from the public venue list.
          </p>
          <Link className="button-primary mt-5" href="/venues">
            Browse venues
          </Link>
        </div>
      )}
    </main>
  );
}
