import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  fetchVenueHoursPatch,
  type VenueForHoursRefresh,
} from "@/lib/venues/venue-hours-fetcher";
import {
  getActiveVenueHoursRefreshTargets,
  getDueVenueHoursRefreshTargets,
  selectVenuesForHoursRefresh,
} from "@/lib/venues/venue-hours-refresh";

const DEFAULT_REFRESH_DELAY_MS = 1_000;
const DEFAULT_REFRESH_LIMIT = 10;
const MAX_REFRESH_DELAY_MS = 5_000;
const MAX_REFRESH_LIMIT = 100;

const listVenuesQuery = "venues:listVenues" as unknown as FunctionReference<"query">;
const patchVenueHoursMutation =
  "venues:patchVenueHours" as unknown as FunctionReference<"mutation">;

function isGoogleFallbackEnabled(): boolean {
  return process.env.VENUE_HOURS_GOOGLE_FALLBACK === "true";
}

function getConvexClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

function parseRefreshLimit(value: string | undefined): number {
  if (!value) {
    return DEFAULT_REFRESH_LIMIT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_REFRESH_LIMIT;
  }

  return Math.min(parsed, MAX_REFRESH_LIMIT);
}

function parseRefreshDelayMs(value: string | undefined): number {
  if (!value) {
    return DEFAULT_REFRESH_DELAY_MS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_REFRESH_DELAY_MS;
  }

  return Math.min(parsed, MAX_REFRESH_DELAY_MS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  try {
    const convex = getConvexClient();
    const serviceSecret = requireServiceSecret();
    const venues = (await convex.query(listVenuesQuery, {
      serviceSecret,
    })) as VenueForHoursRefresh[];
    const refreshLimit = parseRefreshLimit(process.env.VENUE_HOURS_REFRESH_LIMIT);
    const refreshDelayMs = parseRefreshDelayMs(process.env.VENUE_HOURS_REFRESH_DELAY_MS);
    const googleFallbackRequested = isGoogleFallbackEnabled();
    const googleApiKey = googleFallbackRequested
      ? (process.env.GOOGLE_MAPS_API_KEY ?? "").trim()
      : "";
    const googleFallback = Boolean(googleFallbackRequested && googleApiKey);
    const now = Date.now();
    const activeVenueCount = getActiveVenueHoursRefreshTargets(venues).length;
    const dueVenueCount = getDueVenueHoursRefreshTargets(venues, now).length;
    const activeVenues = selectVenuesForHoursRefresh(venues, refreshLimit, now);
    const summary = {
      checked: 0,
      deferred: Math.max(0, dueVenueCount - activeVenues.length),
      delayMs: refreshDelayMs,
      eligible: dueVenueCount,
      refreshed: 0,
      skippedFresh: Math.max(0, activeVenueCount - dueVenueCount),
      failed: 0,
      googleFallback,
      googleFallbackMissingKey: googleFallbackRequested && !googleApiKey,
      googleFallbackRequested,
      results: [] as Array<{
        error?: string;
        id?: string;
        name: string;
        source?: string;
        status: "failed" | "refreshed" | "skipped";
      }>,
    };

    for (const [index, venue] of activeVenues.entries()) {
      summary.checked += 1;
      try {
        const patch = await fetchVenueHoursPatch(venue, {
          googleApiKey: googleFallback ? googleApiKey : undefined,
          now,
        });
        if (!patch) {
          summary.skippedFresh += 1;
          summary.results.push({
            id: venue._id,
            name: venue.name,
            status: "skipped",
          });
          continue;
        }

        await convex.mutation(patchVenueHoursMutation, {
          id: venue._id,
          patch,
          serviceSecret,
        });
        summary.refreshed += 1;
        summary.results.push({
          id: venue._id,
          name: venue.name,
          source: patch.hoursSource,
          status: "refreshed",
        });
      } catch (error) {
        summary.failed += 1;
        summary.results.push({
          error: error instanceof Error ? error.message : "Unknown refresh error.",
          id: venue._id,
          name: venue.name,
          status: "failed",
        });
      }

      if (refreshDelayMs > 0 && index < activeVenues.length - 1) {
        await wait(refreshDelayMs);
      }
    }

    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to refresh venue hours.",
      },
      { status: 500 },
    );
  }
}
