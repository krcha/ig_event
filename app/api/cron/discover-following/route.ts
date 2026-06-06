import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  runFollowDiscoveryWorkflow,
  scrapeInstagramFollowingAccounts,
  type DiscoveredVenueInput,
  type VenueListRecord,
} from "@/lib/pipeline/follow-discovery";
import { runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const listVenuesQuery = "venues:listVenues" as unknown as FunctionReference<"query">;
const createVenueMutation =
  "venues:createVenue" as unknown as FunctionReference<"mutation">;

function isAuthorizedCronRequest(request: Request): boolean {
  return isAuthorizedCronRequestHeader(request.headers.get("authorization"));
}

function logInfo(event: string, payload: Record<string, unknown>) {
  console.info(
    JSON.stringify({
      level: "info",
      event,
      ...payload,
    }),
  );
}

function logError(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...payload,
    }),
  );
}

function getConvexClient() {
  return new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  try {
    const convex = getConvexClient();
    const result = await runFollowDiscoveryWorkflow({
      env: process.env,
      deps: {
        scrapeFollowing: (apifyRequest) =>
          scrapeInstagramFollowingAccounts({ request: apifyRequest }),
        listVenues: async () =>
          (await convex.query(listVenuesQuery, {})) as VenueListRecord[],
        createVenue: async (venue: DiscoveredVenueInput) =>
          convex.mutation(createVenueMutation, venue),
        runVenueIngestion: async (options) => runInstagramIngestion(options),
      },
    });

    logInfo("follow_discovery.completed", {
      sourceHandle: result.sourceHandle,
      followingCount: result.followingCount,
      existingVenueCount: result.existingVenueCount,
      createdHandles: result.createdHandles,
      skippedExisting: result.skippedExisting,
      skippedDuplicate: result.skippedDuplicate,
      skippedInvalid: result.skippedInvalid,
      ingestionTriggered: result.ingestionTriggered,
      costControls: result.costControls,
    });

    return NextResponse.json({
      source: "cron_follow_discovery",
      ...result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to run follow discovery.";
    logError("follow_discovery.failed", { error: message });
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
