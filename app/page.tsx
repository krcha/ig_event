import type { Metadata } from "next";
import EventsBrowsePage from "./(main)/events-browse-page";
import { SITE_DESCRIPTION, SITE_ORIGIN } from "@/lib/seo/site";

// The calendar is backed by external Convex reads. A persisted Next.js route
// cache can outlive ingestion updates and keep serving old event counts, so keep
// the page dynamic and rely on the bounded in-process event loader cache instead.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RootPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: RootPageProps): Promise<Metadata> {
  const resolvedSearchParams = await searchParams;
  const hasSearchParams = Object.values(resolvedSearchParams ?? {}).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
  const title = "Belgrade Events Today: Nightlife & Culture";

  return {
    title,
    description: SITE_DESCRIPTION,
    alternates: {
      canonical: "/",
    },
    openGraph: {
      title: `${title} | Event Zeka`,
      description: SITE_DESCRIPTION,
      type: "website",
      locale: "en_RS",

      siteName: "Event Zeka",
      url: SITE_ORIGIN,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | Event Zeka`,
      description: SITE_DESCRIPTION,
    },
    robots: {
      index: !hasSearchParams,
      follow: true,
      googleBot: {
        index: !hasSearchParams,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
  };
}

export default EventsBrowsePage;
