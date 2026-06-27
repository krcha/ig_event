import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  ExternalLink,
  Grid3X3,
  ImageIcon,
  Instagram,
  MapPin,
  MessageCircle,
  Route,
  Sparkles,
} from "lucide-react";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { VenueWeeklyHours } from "@/components/venues/venue-weekly-hours";
import {
  loadPublicVenuePage,
  type PublicInstagramPost,
  type PublicVenue,
  type PublicVenueEvent,
} from "@/lib/venues/public-venue-pages";
import { getDisplayEventTime } from "@/lib/events/event-time";
import { isApifyImageUrl } from "@/lib/images/apify-images";
import { cn } from "@/lib/utils";

export const revalidate = 60;

type VenuePageProps = {
  params: { venueId: string };
};

type IconComponent = typeof CalendarDays;

type VenueEventPost = PublicVenueEvent & {
  postStatus: "past" | "upcoming";
  sortDate: string;
};

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

function formatPostEventDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
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

function getVenueInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();

  return initials || "VE";
}

function buildEventPosts(
  upcomingEvents: PublicVenueEvent[],
  historyEvents: PublicVenueEvent[],
): VenueEventPost[] {
  return [
    ...upcomingEvents.map((event) => ({
      ...event,
      postStatus: "upcoming" as const,
      sortDate: event.date,
    })),
    ...historyEvents.map((event) => ({
      ...event,
      postStatus: "past" as const,
      sortDate: event.date,
    })),
  ].sort((left, right) => {
    const dateOrder = right.sortDate.localeCompare(left.sortDate);
    if (dateOrder !== 0) {
      return dateOrder;
    }
    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
}

function getProfileImageSrc(
  eventPosts: VenueEventPost[],
  recentInstagramPosts: PublicInstagramPost[],
): string | null {
  return (
    eventPosts.find((event) => event.imageUrl)?.imageUrl ??
    recentInstagramPosts.find((post) => post.imageUrl)?.imageUrl ??
    null
  );
}

function PublicImage({
  alt,
  className,
  sizes,
  src,
}: {
  alt: string;
  className?: string;
  sizes: string;
  src: string;
}) {
  if (isApifyImageUrl(src)) {
    return (
      <Image
        alt={alt}
        className={className}
        fill
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
      loading="lazy"
      src={src}
    />
  );
}

function ProfileStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 text-center sm:text-left">
      <p className="truncate text-lg font-semibold leading-6 text-foreground sm:text-xl">
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] font-medium leading-4 text-muted-foreground sm:text-xs">
        {label}
      </p>
    </div>
  );
}

function ProfileHighlight({
  href,
  icon: Icon,
  label,
  value,
}: {
  href: string;
  icon: IconComponent;
  label: string;
  value: string;
}) {
  return (
    <a
      className="group flex h-24 w-24 flex-none flex-col items-center justify-center gap-1 rounded-[1rem] border border-border/70 bg-white/[0.025] px-2 text-center hover:border-primary/35 hover:bg-white/[0.05] sm:h-28 sm:w-28"
      href={href}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border/75 bg-background/80 text-primary transition group-hover:border-primary/35 group-hover:bg-primary/[0.12]">
        <Icon className="h-4 w-4" />
      </span>
      <span className="mt-1 max-w-full truncate text-xs font-semibold leading-4 text-foreground">
        {label}
      </span>
      <span className="max-w-full truncate text-[10px] font-medium leading-3 text-muted-foreground">
        {value}
      </span>
    </a>
  );
}

function VenueAvatar({
  imageSrc,
  venue,
}: {
  imageSrc: string | null;
  venue: PublicVenue;
}) {
  return (
    <div className="relative mx-auto h-24 w-24 overflow-hidden rounded-full border border-border/75 bg-card shadow-[0_18px_42px_-30px_rgba(0,0,0,0.95)] sm:h-36 sm:w-36">
      {imageSrc ? (
        <PublicImage
          alt={`${venue.name} profile image`}
          className="object-cover"
          sizes="(max-width: 640px) 96px, 144px"
          src={imageSrc}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-primary/[0.12] text-2xl font-semibold text-primary sm:text-4xl">
          {getVenueInitials(venue.name)}
        </div>
      )}
    </div>
  );
}

function VenueMapPanel({ className, venue }: { className?: string; venue: PublicVenue }) {
  const embedUrl = getOpenStreetMapEmbedUrl(venue);
  const directionsHref = getDirectionsHref(venue);

  return (
    <section
      className={cn(
        "overflow-hidden rounded-[1rem] border border-border/75 bg-white/[0.025]",
        className,
      )}
    >
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
        <a
          className="button-secondary min-h-10 gap-2 px-4 py-0"
          href={directionsHref}
          target="_blank"
          rel="noreferrer"
        >
          <Route className="h-4 w-4" />
          Directions
        </a>
      </div>
    </section>
  );
}

function EventPostTile({
  event,
}: {
  event: VenueEventPost;
}) {
  const eventTime = event.displayTimeLabel ?? getDisplayEventTime(event.time);
  const statusLabel = event.postStatus === "upcoming" ? "Upcoming" : "Past";

  return (
    <Link
      aria-label={`${event.title} at ${formatPostEventDate(event.date)}`}
      className="group relative aspect-square min-w-0 overflow-hidden rounded-[0.55rem] border border-border/70 bg-card transition hover:-translate-y-0.5 hover:border-primary/35 sm:rounded-[0.75rem]"
      href={`/events/${event._id}`}
      prefetch={false}
    >
      {event.imageUrl ? (
        <PublicImage
          alt={event.title}
          className="object-cover transition duration-300 group-hover:scale-105"
          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 30vw, 256px"
          src={event.imageUrl}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/[0.025] text-primary">
          <ImageIcon className="h-7 w-7 sm:h-9 sm:w-9" />
          <span className="max-w-[80%] truncate text-[10px] font-semibold text-muted-foreground sm:text-xs">
            Event post
          </span>
        </div>
      )}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1.5 sm:p-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase leading-3 tracking-[0.12em] backdrop-blur",
            event.postStatus === "upcoming"
              ? "bg-primary/90 text-primary-foreground"
              : "bg-background/78 text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/72 to-transparent px-2 pb-2 pt-10 sm:px-3 sm:pb-3 sm:pt-14">
        <h3 className="line-clamp-2 text-[11px] font-semibold leading-4 text-foreground sm:text-sm sm:leading-5">
          {event.title}
        </h3>
        <p className="mt-1 flex min-w-0 items-center gap-1 text-[10px] font-medium leading-3 text-muted-foreground sm:text-xs">
          <CalendarDays className="h-3 w-3 flex-none" />
          <span className="min-w-0 truncate">
            {formatPostEventDate(event.date)}
            {eventTime ? ` - ${eventTime}` : ""}
          </span>
        </p>
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
          <PublicImage
            alt="Recent Instagram post"
            className="object-cover transition duration-300 group-hover:scale-105"
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
  const { historyEvents, upcomingEvents, venue } = await loadPublicVenuePage(params.venueId, {
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
  const image = [...upcomingEvents, ...historyEvents].find((event) => event.imageUrl)?.imageUrl;

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
    await loadPublicVenuePage(params.venueId, {
      historyLimit: 50,
      upcomingLimit: 50,
    });

  if (!venue && !error) {
    notFound();
  }

  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const instagramHref = venue ? getInstagramHref(venue) : "";
  const locationLabel = venue ? getLocationLabel(venue) : "";
  const followerLabel = formatCompactNumber(venue?.instagramFollowerCount);
  const appFollowerLabel = formatCompactNumber(stats?.appFollowerCount ?? 0);
  const eventPosts = buildEventPosts(upcomingEvents, historyEvents);
  const profileImageSrc = getProfileImageSrc(eventPosts, recentInstagramPosts);
  const approvedPostCount = String(stats?.approvedEventCount ?? eventPosts.length);
  const upcomingCount = String(stats?.approvedUpcomingCount ?? upcomingEvents.length);
  const recentMomentumLabel = `${stats?.recentApprovedCount ?? 0}/${stats?.recentWindowDays ?? 30}d`;

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
          <article className="border-b border-border/75 pb-5 sm:pb-7">
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-7">
              <VenueAvatar imageSrc={profileImageSrc} venue={venue} />

              <div className="min-w-0 space-y-4">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="section-kicker">Venue profile</p>
                    <h1 className="mt-1 line-clamp-2 break-words text-2xl font-semibold leading-tight text-foreground sm:text-4xl">
                      {venue.name}
                    </h1>
                    <a
                      className="mt-1 inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-muted-foreground hover:text-primary"
                      href={instagramHref}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <Instagram className="h-4 w-4 flex-none" />
                      <span className="truncate">@{venue.instagramHandle}</span>
                    </a>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {authEnabled ? (
                      <FavoriteVenueButton
                        className="[&>button]:min-h-10"
                        venueId={venue._id}
                        venueName={venue.name}
                        variant="full"
                      />
                    ) : null}
                    <a
                      className="button-secondary min-h-10 gap-2 px-4 py-0"
                      href={instagramHref}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <Instagram className="h-4 w-4" />
                      Instagram
                    </a>
                    <a
                      className="button-secondary min-h-10 gap-2 px-4 py-0"
                      href={getDirectionsHref(venue)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <Route className="h-4 w-4" />
                      Directions
                    </a>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3 sm:grid-cols-4 sm:px-4">
                  <ProfileStat label="posts" value={approvedPostCount} />
                  <ProfileStat label="IG followers" value={followerLabel} />
                  <ProfileStat label="app followers" value={appFollowerLabel} />
                  <ProfileStat label="upcoming" value={upcomingCount} />
                </div>

                <div className="space-y-2 text-sm leading-6 text-muted-foreground">
                  <div className="flex flex-wrap gap-2">
                    <span className="app-chip bg-primary/[0.14] text-primary">
                      {formatVenueCategory(venue.category)}
                    </span>
                    <span className="app-chip bg-card/95">
                      <Sparkles className="h-3.5 w-3.5" />
                      {recentMomentumLabel} recent
                    </span>
                  </div>
                  <p className="flex max-w-2xl items-start gap-2">
                    <MapPin className="mt-1 h-4 w-4 flex-none text-primary" />
                    <span>{locationLabel}</span>
                  </p>
                </div>
              </div>
            </div>
          </article>

          <section
            aria-label={`${venue.name} profile highlights`}
            className="grid auto-cols-[6rem] grid-flow-col gap-3 overflow-x-auto py-1 sm:auto-cols-[7rem]"
          >
            <ProfileHighlight
              href="#hours"
              icon={Clock3}
              label="Hours"
              value={venue.hoursJson ? "Weekly" : "TBD"}
            />
            <ProfileHighlight
              href="#location"
              icon={MapPin}
              label="Location"
              value={venue.neighborhood ?? "Map"}
            />
            <ProfileHighlight
              href="#posts"
              icon={Sparkles}
              label="Momentum"
              value={recentMomentumLabel}
            />
            <ProfileHighlight
              href={`/?venue=${encodeURIComponent(venue.name)}`}
              icon={CalendarDays}
              label="Calendar"
              value={`${upcomingCount} next`}
            />
          </section>

          <section className="space-y-3" id="posts">
            <SectionHeader
              eyebrow="Posts"
              title="Approved event posts"
              action={
                <Link
                  className="button-secondary min-h-10 gap-2 px-4 py-0"
                  href={`/?venue=${encodeURIComponent(venue.name)}`}
                >
                  <Grid3X3 className="h-4 w-4" />
                  Calendar
                </Link>
              }
            />
            {eventPosts.length > 0 ? (
              <div className="grid grid-cols-3 gap-1 sm:gap-2 lg:gap-2.5">
                {eventPosts.map((event) => (
                  <EventPostTile event={event} key={event._id} />
                ))}
              </div>
            ) : (
              <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-10 text-center">
                <Grid3X3 className="mx-auto h-8 w-8 text-primary" />
                <p className="mt-3 text-sm font-semibold text-foreground">
                  No approved event posts yet.
                </p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  Approved venue and promoter events will appear here as square posts.
                </p>
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <section className="space-y-3" id="hours">
              <SectionHeader eyebrow="Details" title="Hours" />
              {venue.hoursJson ? (
                <VenueWeeklyHours
                  className="bg-white/[0.025]"
                  hoursJson={venue.hoursJson}
                  hoursSource={venue.hoursSource}
                />
              ) : (
                <div className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-8 text-center">
                  <Clock3 className="mx-auto h-7 w-7 text-primary" />
                  <p className="mt-3 text-sm font-semibold text-foreground">
                    Hours are not captured yet.
                  </p>
                </div>
              )}
            </section>

            <section className="space-y-3" id="location">
              <SectionHeader eyebrow="Place" title="Map and directions" />
              <VenueMapPanel className="h-full" venue={venue} />
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
                <Instagram className="mx-auto h-7 w-7 text-primary" />
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
