import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import {
  ArrowRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Heart,
  Instagram,
  MapPin,
  Search,
  SlidersHorizontal,
  Users,
  Warehouse,
} from "lucide-react";
import { FavoriteVenueButton } from "@/components/venues/favorite-venue-button";
import { JsonLd } from "@/components/seo/json-ld";
import {
  loadPublicVenueDirectory,
  type PublicVenueDirectoryItem,
} from "@/lib/venues/public-venue-pages";
import {
  buildPublicVenueDirectoryPageHref,
  normalizePublicVenueDirectoryPage,
  paginatePublicVenueDirectory,
} from "@/lib/venues/public-venue-directory-pagination";
import {
  SITE_ORIGIN,
  buildVenueDirectoryStructuredData,
} from "@/lib/seo/site";
import { cn } from "@/lib/utils";

export const revalidate = 60;

const loadVenueDirectory = cache(() => loadPublicVenueDirectory());

type VenuesSearchParams = {
  category?: string | string[];
  page?: string | string[];
  q?: string | string[];
  upcoming?: string | string[];
};

type VenuesPageProps = {
  searchParams?: Promise<VenuesSearchParams>;
};

export async function generateMetadata({ searchParams }: VenuesPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const requestedPage = normalizePublicVenueDirectoryPage(
    getSingleValue(resolvedSearchParams?.page),
  );
  const hasFilters = Boolean(
    getSingleValue(resolvedSearchParams?.category)?.trim() ||
      getSingleValue(resolvedSearchParams?.q)?.trim() ||
      getSingleValue(resolvedSearchParams?.upcoming),
  );
  const { venues } = await loadVenueDirectory();
  const currentPage = hasFilters
    ? 1
    : paginatePublicVenueDirectory(venues, requestedPage).currentPage;
  const canonicalPath = currentPage > 1 ? `/venues?page=${currentPage}` : "/venues";
  const title =
    currentPage > 1
      ? `Belgrade Venue Guide — Page ${currentPage}`
      : "Belgrade Venues: Nightlife & Culture Guide";
  const description =
    "Explore Belgrade clubs, bars, concert spaces, galleries, theatres, and cultural venues with upcoming events, locations, and official Instagram links.";

  return {
    title,
    description,
    alternates: {
      canonical: canonicalPath,
    },
    openGraph: {
      title: `${title} | Event Zeka`,
      description,
      type: "website",
      locale: "en_RS",

      siteName: "Event Zeka",
      url: new URL(canonicalPath, SITE_ORIGIN).toString(),
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | Event Zeka`,
      description,
    },
    robots: {
      index: !hasFilters,
      follow: true,
      googleBot: {
        index: !hasFilters,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
}

function getSingleValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

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

function getLocationLabel(venue: PublicVenueDirectoryItem): string {
  return [venue.location, venue.neighborhood].filter(Boolean).join(", ") || "Belgrade";
}

function venueMatchesQuery(venue: PublicVenueDirectoryItem, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = normalizeSearchText(
    [
      venue.name,
      venue.instagramHandle,
      venue.category,
      venue.location,
      venue.neighborhood,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return haystack.includes(normalizeSearchText(query));
}

function filterVenues(
  venues: PublicVenueDirectoryItem[],
  options: {
    category?: string;
    query?: string;
    upcomingOnly: boolean;
  },
): PublicVenueDirectoryItem[] {
  return venues.filter((venue) => {
    if (options.category && venue.category !== options.category) {
      return false;
    }
    if (options.upcomingOnly && venue.upcomingEventCount < 1) {
      return false;
    }
    return venueMatchesQuery(venue, options.query ?? "");
  });
}

function VenueDirectoryCard({
  authEnabled,
  venue,
}: {
  authEnabled: boolean;
  venue: PublicVenueDirectoryItem;
}) {
  return (
    <article className="rounded-[1rem] border border-border/75 bg-white/[0.025] p-4 transition hover:border-primary/35 hover:bg-white/[0.045]">
      <div className="flex items-start justify-between gap-3">
        <Link className="min-w-0" href={`/venues/${venue._id}`} prefetch={false}>
          <p className="section-kicker">{venue.category || "Venue"}</p>
          <h2 className="mt-1 line-clamp-2 text-lg font-semibold leading-6 text-foreground">
            {venue.name}
          </h2>
        </Link>
        {authEnabled ? (
          <FavoriteVenueButton
            className="flex-none"
            venueId={venue._id}
            venueName={venue.name}
          />
        ) : null}
      </div>

      <div className="mt-4 space-y-2 text-sm leading-5 text-muted-foreground">
        <p className="flex min-w-0 items-center gap-2">
          <Instagram className="h-4 w-4 flex-none text-primary" />
          <span className="truncate">@{venue.instagramHandle}</span>
        </p>
        <p className="flex min-w-0 items-center gap-2">
          <MapPin className="h-4 w-4 flex-none text-primary" />
          <span className="truncate">{getLocationLabel(venue)}</span>
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[0.85rem] border border-border/70 bg-card/70 px-3 py-2">
          <p className="section-kicker">Upcoming</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <CalendarDays className="h-4 w-4 text-primary" />
            {venue.upcomingEventCount}
          </p>
        </div>
        <div className="rounded-[0.85rem] border border-border/70 bg-card/70 px-3 py-2">
          <p className="section-kicker">Followers</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Users className="h-4 w-4 text-primary" />
            {formatCompactNumber(venue.instagramFollowerCount)}
          </p>
        </div>
      </div>

      <Link
        className="button-secondary mt-4 min-h-10 w-full gap-2 px-4 py-0"
        href={`/venues/${venue._id}`}
        prefetch={false}
      >
        Venue page
        <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

export default async function VenuesPage({ searchParams }: VenuesPageProps) {
  const resolvedSearchParams = await searchParams;
  const { error, venues } = await loadVenueDirectory();
  if (error) {
    throw new Error(`Failed to load public venue directory: ${error}`);
  }

  const selectedCategory = getSingleValue(resolvedSearchParams?.category)?.trim();
  const searchQuery = getSingleValue(resolvedSearchParams?.q)?.trim() ?? "";
  const upcomingOnly = getSingleValue(resolvedSearchParams?.upcoming) === "1";
  const categories = Array.from(
    new Set(venues.map((venue) => venue.category).filter((category): category is string => Boolean(category))),
  ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
  const filteredVenues = filterVenues(venues, {
    category: selectedCategory,
    query: searchQuery,
    upcomingOnly,
  });
  const requestedPage = normalizePublicVenueDirectoryPage(
    getSingleValue(resolvedSearchParams?.page),
  );
  const {
    currentPage,
    firstItemNumber,
    lastItemNumber,
    pageItems: visibleVenues,
    totalPages,
  } = paginatePublicVenueDirectory(filteredVenues, requestedPage);
  const activeFilterCount = [selectedCategory, searchQuery, upcomingOnly ? "1" : ""].filter(
    Boolean,
  ).length;
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const previousPageHref = buildPublicVenueDirectoryPageHref({
    category: selectedCategory,
    page: currentPage > 2 ? String(currentPage - 1) : undefined,
    q: searchQuery || undefined,
    upcoming: upcomingOnly ? "1" : undefined,
  });
  const nextPageHref = buildPublicVenueDirectoryPageHref({
    category: selectedCategory,
    page: String(currentPage + 1),
    q: searchQuery || undefined,
    upcoming: upcomingOnly ? "1" : undefined,
  });

  return (
    <main className="app-page gap-4 pb-[calc(7rem+env(safe-area-inset-bottom))] md:pb-9">
      <JsonLd
        data={buildVenueDirectoryStructuredData(visibleVenues, currentPage, firstItemNumber)}
      />
      <section className="hero-panel px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[1rem] bg-primary text-primary-foreground">
              <Warehouse className="h-5 w-5" />
            </span>
            <p className="section-kicker mt-4">Venues</p>
            <h1 className="mt-2 text-3xl font-semibold leading-tight text-foreground sm:text-5xl">
              Belgrade venue guide
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Clubs, bars, galleries, theatres, concert spaces, and late-night rooms for locals and
              visitors. Vodič kroz beogradske klubove i kulturne prostore sa aktuelnim događajima.
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 lg:w-auto lg:min-w-80">
            <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
              <p className="section-kicker">Venues</p>
              <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-foreground">
                <Warehouse className="h-4 w-4 text-primary" />
                {venues.length}
              </p>
            </div>
            <div className="rounded-[1rem] border border-border/75 bg-white/[0.025] px-3 py-3">
              <p className="section-kicker">With events</p>
              <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-foreground">
                <CalendarDays className="h-4 w-4 text-primary" />
                {venues.filter((venue) => venue.upcomingEventCount > 0).length}
              </p>
            </div>
          </div>
        </div>
      </section>

      <form className="glass-panel grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_14rem_auto_auto] lg:items-center" action="/venues">
        <label className="relative min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            className="min-h-11 w-full rounded-[0.9rem] border border-border/75 bg-background/80 py-0 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary/45"
            defaultValue={searchQuery}
            name="q"
            placeholder="Search venues"
          />
        </label>
        <label className="min-w-0">
          <select
            className="min-h-11 w-full rounded-[0.9rem] border border-border/75 bg-background/80 px-3 text-sm text-foreground outline-none focus:border-primary/45"
            defaultValue={selectedCategory ?? ""}
            name="category"
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[0.9rem] border border-border/75 bg-background/80 px-3 text-sm font-semibold text-foreground">
          <input
            className="h-4 w-4 accent-primary"
            defaultChecked={upcomingOnly}
            name="upcoming"
            type="checkbox"
            value="1"
          />
          Upcoming
        </label>
        <button className="button-primary min-h-11 gap-2 px-4 py-0" type="submit">
          <SlidersHorizontal className="h-4 w-4" />
          Filter
        </button>
      </form>

      {activeFilterCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="app-chip bg-card/95">{filteredVenues.length} matches</span>
          <Link className="app-chip bg-white/[0.04] hover:bg-white/[0.07]" href="/venues">
            Clear filters
          </Link>
        </div>
      ) : null}

      {filteredVenues.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <p aria-live="polite">
              Showing {firstItemNumber}–{lastItemNumber} of {filteredVenues.length} venues
            </p>
            <p>
              Page {currentPage} of {totalPages}
            </p>
          </div>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleVenues.map((venue) => (
              <VenueDirectoryCard authEnabled={authEnabled} key={venue._id} venue={venue} />
            ))}
          </section>
          {totalPages > 1 ? (
            <nav
              aria-label="Venue directory pages"
              className="flex items-center justify-between gap-3"
            >
              {currentPage > 1 ? (
                <Link
                  className="button-secondary min-h-11 gap-2 px-4 py-0"
                  href={`/venues${previousPageHref}`}
                  prefetch={false}
                  rel="prev"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Link>
              ) : (
                <span />
              )}
              {currentPage < totalPages ? (
                <Link
                  className="button-secondary min-h-11 gap-2 px-4 py-0"
                  href={`/venues${nextPageHref}`}
                  prefetch={false}
                  rel="next"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <section className="rounded-[1rem] border border-dashed border-border/80 bg-white/[0.025] px-4 py-10 text-center">
          <Heart className="mx-auto h-7 w-7 text-primary" />
          <h2 className="mt-4 text-lg font-semibold text-foreground">No venues found</h2>
          <Link
            className={cn("button-secondary mt-5", activeFilterCount === 0 && "hidden")}
            href="/venues"
          >
            Clear filters
          </Link>
        </section>
      )}
    </main>
  );
}
