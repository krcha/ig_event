import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  Grid3X3,
  ImageIcon,
  Instagram,
  MapPin,
} from "lucide-react";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { JsonLd } from "@/components/seo/json-ld";
import {
  loadPublicVenuePage,
  type PublicVenue,
  type PublicVenueEvent,
} from "@/lib/venues/public-venue-pages";
import { buildDiscoverImageUrl } from "@/lib/discover/discover-image-source";
import { isPlausibleConvexPublicId } from "@/lib/convex/public-id";
import { getDisplayEventTime } from "@/lib/events/event-time";
import { isApifyImageUrl, isApifySourcedImageUrl } from "@/lib/images/apify-images";
import {
  absoluteUrl,
  buildBreadcrumbStructuredData,
  buildVenueStructuredData,
  clipText,
} from "@/lib/seo/site";
import { cn } from "@/lib/utils";

export const revalidate = 60;

type VenuePageProps = {
  params: Promise<{ venueId: string }>;
};

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

function getVenueAvatarText(name: string): string {
  const compactName = name.trim().replace(/\s+/g, "");
  if (/^\d/.test(compactName)) {
    return compactName.slice(0, 5).toLocaleUpperCase();
  }

  return getVenueInitials(name);
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

function PublicImage({
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
  const useNextImage = src.startsWith("/api/discover/images/") || isApifyImageUrl(src);

  if (useNextImage) {
    return (
      <Image
        alt={alt}
        className={className}
        fill
        priority={priority}
        sizes={sizes}
        src={src}
        unoptimized
      />
    );
  }

  return (
    <img
      alt={alt}
      className={cn("absolute inset-0 h-full w-full", className)}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      loading={priority ? "eager" : "lazy"}
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
    <div className="min-w-0 text-center">
      <p className="truncate text-lg font-semibold leading-6 text-foreground sm:text-2xl">
        {value}
      </p>
      <p className="mt-0.5 truncate text-[11px] font-medium leading-4 text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function VenueAvatar({
  venue,
}: {
  venue: PublicVenue;
}) {
  return (
    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-border/80 bg-card text-lg font-semibold text-primary sm:h-36 sm:w-36 sm:text-3xl">
      <span className="max-w-[82%] truncate">{getVenueAvatarText(venue.name)}</span>
    </div>
  );
}

function VenueBio({ venue }: { venue: PublicVenue }) {
  return (
    <div className="space-y-1.5 text-sm leading-6 text-muted-foreground">
      <p className="font-medium text-foreground">{formatVenueCategory(venue.category)}</p>
      <p className="flex items-center gap-1.5">
        <MapPin className="h-3.5 w-3.5 flex-none text-primary" />
        <span>{getLocationLabel(venue)}</span>
      </p>
      <a
        className="inline-flex items-center gap-1.5 font-semibold text-primary hover:text-primary/80"
        href={getDirectionsHref(venue)}
        rel="noreferrer"
        target="_blank"
      >
        <MapPin className="h-3.5 w-3.5" />
        Open directions
      </a>
    </div>
  );
}

function getProfileStats(options: {
  approvedPostCount: string;
  appFollowerCount: number;
  instagramFollowerCount?: number | null;
  upcomingCount: string;
}): Array<{ label: string; value: string }> {
  const stats = [
    { label: "posts", value: options.approvedPostCount },
    { label: "upcoming", value: options.upcomingCount },
  ];

  if (options.appFollowerCount > 0) {
    stats.push({ label: "saved by", value: formatCompactNumber(options.appFollowerCount) });
  }

  if (
    typeof options.instagramFollowerCount === "number" &&
    Number.isFinite(options.instagramFollowerCount)
  ) {
    stats.push({
      label: "IG followers",
      value: formatCompactNumber(options.instagramFollowerCount),
    });
  }

  return stats;
}

function ProfileActions({
  authEnabled,
  instagramHref,
  venue,
}: {
  authEnabled: boolean;
  instagramHref: string;
  venue: PublicVenue;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {authEnabled ? (
        <FavoriteVenueButton
          className="[&>button]:min-h-9 [&>button]:px-4"
          venueId={venue._id}
          venueName={venue.name}
          variant="full"
        />
      ) : null}
      <a
        className="button-secondary min-h-9 gap-2 px-4 py-0"
        href={instagramHref}
        rel="noreferrer"
        target="_blank"
      >
        <Instagram className="h-4 w-4" />
        Instagram
      </a>
    </div>
  );
}

function getEventPostImageSrc(event: VenueEventPost, venue: PublicVenue): string | null {
  if (!event.imageUrl) {
    return null;
  }

  if (isApifySourcedImageUrl(event.imageUrl)) {
    return buildDiscoverImageUrl({
      _id: event._id,
      imageUrl: event.imageUrl,
      instagramHandle: venue.instagramHandle,
    });
  }

  return event.imageUrl;
}

function EventPostTile({
  event,
  priority = false,
  venue,
}: {
  event: VenueEventPost;
  priority?: boolean;
  venue: PublicVenue;
}) {
  const eventTime = event.displayTimeLabel ?? getDisplayEventTime(event.time);
  const imageSrc = getEventPostImageSrc(event, venue);

  return (
    <Link
      aria-label={`${event.title} at ${formatPostEventDate(event.date)}`}
      className="group relative aspect-square min-w-0 overflow-hidden bg-card"
      href={`/events/${event._id}`}
      prefetch={false}
    >
      {imageSrc ? (
        <PublicImage
          alt=""
          className="object-cover transition duration-300 group-hover:scale-105"
          priority={priority}
          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 30vw, 256px"
          src={imageSrc}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-white/[0.025] px-2 text-center text-primary">
          <ImageIcon className="h-7 w-7 sm:h-9 sm:w-9" />
          <span className="line-clamp-2 text-[10px] font-semibold leading-3 text-foreground sm:text-xs sm:leading-4">
            {event.title}
          </span>
          <span className="flex max-w-full items-center gap-1 truncate text-[9px] font-medium leading-3 text-muted-foreground sm:text-[11px]">
            <CalendarDays className="h-3 w-3 flex-none" />
            <span className="truncate">
              {formatPostEventDate(event.date)}
              {eventTime ? ` - ${eventTime}` : ""}
            </span>
          </span>
        </div>
      )}
    </Link>
  );
}

export async function generateMetadata({ params }: VenuePageProps): Promise<Metadata> {
  const { venueId } = await params;
  if (!isPlausibleConvexPublicId(venueId)) {
    notFound();
  }

  const { error, historyEvents, upcomingEvents, venue } = await loadPublicVenuePage(venueId, {
    historyLimit: 3,
    upcomingLimit: 3,
  });

  if (error) {
    throw new Error(`Failed to load public venue metadata: ${error}`);
  }
  if (!venue) {
    notFound();
  }

  const canonicalPath = `/venues/${venue._id}`;
  const location = getLocationLabel(venue);
  const description = clipText(
    upcomingEvents.length > 0
      ? `${venue.name} in ${location}: ${upcomingEvents.length} upcoming Belgrade event${upcomingEvents.length === 1 ? "" : "s"}, location, Instagram, and venue details.`
      : `${venue.name} in ${location}: Belgrade venue guide with location, official Instagram, and approved event history.`,
    160,
  );
  const image = [...upcomingEvents, ...historyEvents].find((event) => event.imageUrl)?.imageUrl;
  const socialTitle = `${venue.name} — Belgrade venue events`;

  return {
    title: clipText(`${venue.name} — Belgrade venue events`, 62),
    description,
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: socialTitle,
      description,
      ...(image ? { images: [{ url: absoluteUrl(image), alt: `${venue.name} in Belgrade` }] } : {}),
      type: "website",
      locale: "en_RS",

      siteName: "Event Zeka",
      url: absoluteUrl(canonicalPath),
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      ...(image ? { images: [absoluteUrl(image)] } : {}),
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
}

export default async function VenuePage({ params }: VenuePageProps) {
  const { venueId } = await params;
  if (!isPlausibleConvexPublicId(venueId)) {
    notFound();
  }

  const { error, historyEvents, stats, upcomingEvents, venue } = await loadPublicVenuePage(
    venueId,
    {
      historyLimit: 50,
      upcomingLimit: 50,
    },
  );

  if (error) {
    throw new Error(`Failed to load public venue page: ${error}`);
  }
  if (!venue) {
    notFound();
  }

  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const instagramHref = venue ? getInstagramHref(venue) : "";
  const eventPosts = buildEventPosts(upcomingEvents, historyEvents);
  const approvedPostCount = String(stats?.approvedEventCount ?? eventPosts.length);
  const upcomingCount = String(stats?.approvedUpcomingCount ?? upcomingEvents.length);
  const calendarHref = venue ? `/?venue=${encodeURIComponent(venue.name)}` : "/";
  const priorityEventId = venue
    ? eventPosts.find((event) => getEventPostImageSrc(event, venue))?._id
    : null;
  const profileStats = venue
    ? getProfileStats({
        approvedPostCount,
        appFollowerCount: stats?.appFollowerCount ?? 0,
        instagramFollowerCount: venue.instagramFollowerCount,
        upcomingCount,
      })
    : [];

  return (
    <main className="app-page pb-[calc(7rem+env(safe-area-inset-bottom))] md:pb-9">
      {venue ? (
        <>
          <JsonLd data={buildVenueStructuredData(venue)} />
          <JsonLd
            data={buildBreadcrumbStructuredData([
              { name: "Belgrade events", path: "/" },
              { name: "Belgrade venues", path: "/venues" },
              { name: venue.name, path: `/venues/${venue._id}` },
            ])}
          />
        </>
      ) : null}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        {venue ? (
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Link className="hover:text-primary" href="/">Belgrade events</Link>
            <span aria-hidden="true">/</span>
            <Link className="hover:text-primary" href="/venues">Venues</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="min-w-0 truncate text-foreground">{venue.name}</span>
          </nav>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <Link className="button-secondary min-h-10 gap-2 px-4 py-0" href={calendarHref}>
            <ArrowLeft className="h-4 w-4" />
            Calendar
          </Link>
        </div>

        {venue ? (
          <>
            <article className="border-b border-border/75 pb-5 sm:pb-7">
              <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-8">
                <VenueAvatar venue={venue} />

                <div className="min-w-0 space-y-4">
                  <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <h1 className="truncate text-2xl font-semibold leading-tight text-foreground sm:text-4xl">
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

                    <ProfileActions
                      authEnabled={authEnabled}
                      instagramHref={instagramHref}
                      venue={venue}
                    />
                  </div>

                  <div
                    className={cn(
                      "grid max-w-xl gap-x-5 gap-y-3",
                      profileStats.length > 2 ? "grid-cols-3" : "grid-cols-2",
                      profileStats.length > 3 && "sm:grid-cols-4",
                    )}
                  >
                    {profileStats.map((item) => (
                      <ProfileStat key={item.label} label={item.label} value={item.value} />
                    ))}
                  </div>

                  <VenueBio venue={venue} />
                </div>
              </div>
            </article>

            <section aria-label={`${venue.name} event posts`} id="posts">
              <div className="flex items-center justify-center border-b border-border/75">
                <span className="inline-flex border-t border-primary px-4 py-3 text-xs font-semibold uppercase leading-4 tracking-[0.12em] text-foreground">
                  <Grid3X3 className="mr-2 h-4 w-4" />
                  Posts
                </span>
              </div>

              {eventPosts.length > 0 ? (
                <div className="grid grid-cols-3 gap-px pt-1 sm:gap-1.5">
                  {eventPosts.map((event) => (
                    <EventPostTile
                      event={event}
                      key={event._id}
                      priority={event._id === priorityEventId}
                      venue={venue}
                    />
                  ))}
                </div>
              ) : (
                <div className="px-4 py-16 text-center">
                  <Grid3X3 className="mx-auto h-8 w-8 text-primary" />
                  <p className="mt-3 text-sm font-semibold text-foreground">
                    No event posts yet.
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
            <Link className="button-primary mt-5" href="/">
              Back to calendar
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
