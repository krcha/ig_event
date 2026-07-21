import { addDaysToDateKey } from "../events/nightlife-date.ts";

type SitemapLoadResult = {
  error?: string;
};

type LoadValidatedSitemapPublicDataOptions<
  EventResult extends SitemapLoadResult,
  VenueResult extends SitemapLoadResult,
> = {
  loadEvents: (options: {
    beforeDate: string;
    fromDate: string;
  }) => Promise<EventResult>;
  loadVenues: (options: {
    limit: number;
    today: string;
  }) => Promise<VenueResult>;
  today: string;
};

function sitemapLoadError(error: string | undefined): Error {
  return new Error(`Unable to build SEO sitemap: ${error ?? "Unknown public data error."}`);
}

export async function loadValidatedSitemapPublicData<
  EventResult extends SitemapLoadResult,
  VenueResult extends SitemapLoadResult,
>(
  options: LoadValidatedSitemapPublicDataOptions<EventResult, VenueResult>,
): Promise<{
  eventResult: EventResult;
  venueResult: VenueResult;
}> {
  const eventResult = await options.loadEvents({
    fromDate: options.today,
    beforeDate: addDaysToDateKey(options.today, 367),
  });
  if (eventResult.error) {
    throw sitemapLoadError(eventResult.error);
  }

  const venueResult = await options.loadVenues({
    limit: 2000,
    today: options.today,
  });
  if (venueResult.error) {
    throw sitemapLoadError(venueResult.error);
  }

  return { eventResult, venueResult };
}
