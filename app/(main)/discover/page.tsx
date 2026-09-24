import type { Metadata } from "next";
import {
  type DiscoverDateTab,
  DiscoverFeed,
} from "@/components/discover/discover-feed";
import { loadDiscoverEventsPage } from "@/lib/discover/feed-page";
import {
  addDaysToDateKey,
  getNightlifeDefaultDateKey,
  parseDateKeyToUtcNoon,
} from "@/lib/events/nightlife-date";
import { SITE_ORIGIN } from "@/lib/seo/site";

export const revalidate = 60;

type DiscoverPageProps = {
  searchParams?: Promise<{
    date?: string | string[];
    page?: string | string[];
  }>;
};

export async function generateMetadata({ searchParams }: DiscoverPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const hasDateFilter = Boolean(
    Array.isArray(resolvedSearchParams?.date)
      ? resolvedSearchParams.date[0]
      : resolvedSearchParams?.date,
  );
  const hasPageFilter = normalizeRequestedPage(resolvedSearchParams?.page) > 1;
  const title = "Belgrade Events Tonight: Nightlife & Culture Picks";
  const description =
    "Discover what to do in Belgrade tonight: approved club nights, concerts, DJ sets, exhibitions, theatre, film, and cultural events.";

  return {
    title,
    description,
    alternates: {
      canonical: "/discover",
    },
    openGraph: {
      title: `${title} | Event Zeka`,
      description,
      type: "website",
      locale: "en_RS",

      siteName: "Event Zeka",
      url: `${SITE_ORIGIN}/discover`,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | Event Zeka`,
      description,
    },
    robots: {
      index: !hasDateFilter && !hasPageFilter,
      follow: true,
      googleBot: {
        index: !hasDateFilter && !hasPageFilter,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
}

function formatDiscoverSubline(dateKey: string): string {
  const date = parseDateKeyToUtcNoon(dateKey);
  if (!date) {
    return `${dateKey} · Belgrade`;
  }

  const label = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Belgrade",
    weekday: "long",
  }).format(date);
  return `${label} · Belgrade`;
}

function getDateTabDates(today: string): string[] {
  return [addDaysToDateKey(today, -1), today, addDaysToDateKey(today, 1)];
}

function normalizeRequestedDate(
  value: string | string[] | undefined,
  today: string,
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const allowedDates = getDateTabDates(today);
  // Keep an open tab's old date available after the 07:00 nightlife-day rollover.
  return candidate &&
    (allowedDates.includes(candidate) || candidate === addDaysToDateKey(today, -2)) &&
    parseDateKeyToUtcNoon(candidate)
    ? candidate
    : today;
}

function normalizeRequestedPage(value: string | string[] | undefined): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(candidate ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildDiscoverPageHref(options: {
  date: string;
  page: number;
  today: string;
}): string {
  const query = new URLSearchParams();
  if (options.date !== options.today || options.page > 1) {
    query.set("date", options.date);
  }
  if (options.page > 1) {
    query.set("page", String(options.page));
  }
  const serialized = query.toString();
  return serialized ? `/discover?${serialized}` : "/discover";
}

function buildDateTabs(today: string, selectedDate: string): DiscoverDateTab[] {
  const [yesterday, current, tomorrow] = getDateTabDates(today);
  const tabs = selectedDate === addDaysToDateKey(today, -2)
    ? [
        { label: "Selected", date: selectedDate },
        { label: "Yesterday", date: yesterday },
        { label: "Today", date: current },
      ]
    : [
        { label: "Yesterday", date: yesterday },
        { label: "Today", date: current },
        { label: "Tomorrow", date: tomorrow },
      ];

  return tabs.map((tab) => ({
    active: tab.date === selectedDate,
    href: tab.date === today ? "/discover" : `/discover?date=${tab.date}`,
    label: tab.label,
    sublabel: formatEventDateShort(tab.date),
  }));
}

function formatEventDateShort(dateKey: string): string {
  const date = parseDateKeyToUtcNoon(dateKey);
  if (!date) {
    return dateKey;
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Belgrade",
  }).format(date);
}

export default async function DiscoverPage({ searchParams }: DiscoverPageProps) {
  const resolvedSearchParams = await searchParams;
  const today = getNightlifeDefaultDateKey();
  const selectedDate = normalizeRequestedDate(resolvedSearchParams?.date, today);
  const requestedPage = normalizeRequestedPage(resolvedSearchParams?.page);
  const {
    currentPage,
    error,
    events,
    firstEventNumber,
    lastEventNumber,
    revision,
    totalEvents,
    totalPages,
  } = await loadDiscoverEventsPage(selectedDate, requestedPage);
  const authEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <DiscoverFeed
      authEnabled={authEnabled}
      dateTabs={buildDateTabs(today, selectedDate)}
      error={error}
      events={events}
      key={`${selectedDate}:${currentPage}:${revision}`}
      revision={revision}
      selectedDate={selectedDate}
      pagination={{
        currentPage,
        firstEventNumber,
        lastEventNumber,
        ...(currentPage > 1
          ? {
              previousHref: buildDiscoverPageHref({
                date: selectedDate,
                page: currentPage - 1,
                today,
              }),
            }
          : {}),
        ...(currentPage < totalPages
          ? {
              nextHref: buildDiscoverPageHref({
                date: selectedDate,
                page: currentPage + 1,
                today,
              }),
            }
          : {}),
        totalEvents,
        totalPages,
      }}
      subline={formatDiscoverSubline(selectedDate)}
    />
  );
}
