import { getLocale as getMetadataLocale } from "@/i18n/server";
import type { Locale } from "@/i18n/config";
import { formatPublicDate } from "@/lib/i18n/display";
import { publicText } from "@/lib/i18n/public-messages";
import { localizedMetadata } from "@/lib/i18n/seo";
import type { Metadata } from "next";
import {
  type DiscoverDateTab,
  DiscoverFeed,
} from "@/components/discover/discover-feed";
import { loadDiscoverEventsPage } from "@/lib/discover/feed-page";
import { getDiscoverPageCopy } from "@/lib/discover/page-copy";
import {
  addDaysToDateKey,
  getNightlifeDefaultDateKey,
  parseDateKeyToUtcNoon,
} from "@/lib/events/nightlife-date";

export const revalidate = 60;

type DiscoverPageProps = {
  searchParams?: Promise<{
    date?: string | string[];
    page?: string | string[];
  }>;
};

export async function generateMetadata({ searchParams }: DiscoverPageProps): Promise<Metadata> {
  const locale = await getMetadataLocale();
  const resolvedSearchParams = await searchParams;
  const hasDateFilter = Boolean(Array.isArray(resolvedSearchParams?.date) ? resolvedSearchParams.date[0] : resolvedSearchParams?.date);
  const hasPageFilter = normalizeRequestedPage(resolvedSearchParams?.page) > 1;
  const today = getNightlifeDefaultDateKey();
  const selectedDate = normalizeRequestedDate(resolvedSearchParams?.date, today);
  const { title, description } = getDiscoverPageCopy(selectedDate, today, locale);
  return localizedMetadata({ locale, path: "/discover", title, description, index: !hasDateFilter && !hasPageFilter });
}

function formatDiscoverSubline(dateKey: string, locale: Locale): string {
  const date = parseDateKeyToUtcNoon(dateKey);
  if (!date) {
    return `${dateKey} · ${publicText(locale, "Belgrade")}`;
  }

  const label = formatPublicDate(locale, dateKey, {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Belgrade",
    weekday: "long",
  });
  return `${label} · ${publicText(locale, "Belgrade")}`;
}

function getDateTabDates(today: string): string[] {
  return [addDaysToDateKey(today, -1), today, addDaysToDateKey(today, 1)];
}

function normalizeRequestedDate(
  value: string | string[] | undefined,
  today: string,
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const allowedDates = [...getDateTabDates(today), ...Array.from({length:5},(_,index)=>addDaysToDateKey(today,index+2))];
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

function buildDateTabs(today: string, selectedDate: string, locale: Locale): DiscoverDateTab[] {
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
    label: publicText(locale, tab.label),
    sublabel: formatPublicDate(locale, tab.date, { day: "numeric", month: "short" }),
  }));
}

export default async function DiscoverPage({ searchParams }: DiscoverPageProps) {
  const locale = await getMetadataLocale();
  const resolvedSearchParams = await searchParams;
  const today = getNightlifeDefaultDateKey();
  const selectedDate = normalizeRequestedDate(resolvedSearchParams?.date, today);
  const requestedPage = normalizeRequestedPage(resolvedSearchParams?.page);
  const {
    currentPage,
    error,
    events,
    mobileEvents,
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
      dateTabs={buildDateTabs(today, selectedDate, locale)}
      error={error}
      events={events}
      mobileEvents={mobileEvents}
      today={today}
      key={`${selectedDate}:${currentPage}:${revision}`}
      revision={revision}
      selectedDate={selectedDate}
      introduction={getDiscoverPageCopy(selectedDate, today, locale).introduction}
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
      subline={formatDiscoverSubline(selectedDate, locale)}
    />
  );
}
