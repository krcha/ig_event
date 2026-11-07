import { getLocale as getMetadataLocale } from "@/i18n/server";
import { localizedMetadata, SITE_COPY } from "@/lib/i18n/seo";
import type { Metadata } from "next";
import { Suspense } from "react";
import EventsBrowsePage from "./(main)/events-browse-page";
import EventsLoading from "@/components/calendar/events-browse-loading";

// The calendar is backed by external Convex reads. A persisted Next.js route
// cache can outlive ingestion updates and keep serving old event counts, so keep
// the page dynamic and rely on the bounded in-process event loader cache instead.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RootPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: RootPageProps): Promise<Metadata> {
  const locale = await getMetadataLocale();
  const resolvedSearchParams = await searchParams;
  const hasSearchParams = Object.values(resolvedSearchParams ?? {}).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value));
  const copy = SITE_COPY[locale];
  return localizedMetadata({ locale, path: "/", title: copy.homeTitle, description: copy.description, index: !hasSearchParams });
}

export default async function HomePage({ searchParams }: RootPageProps) {
  const params = await searchParams ?? {};
  // A new day is new content. Without a key, a transition retains the old day
  // until every read finishes and the loading boundary never becomes visible.
  const key = JSON.stringify([params.month, params.day, params.open]);
  const day = typeof params.day === "string" ? params.day : undefined;
  return <Suspense key={key} fallback={<EventsLoading day={day} />}><EventsBrowsePage searchParams={Promise.resolve(params)} /></Suspense>;
}
