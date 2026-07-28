import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  buildApifyFollowingScrapeRequest,
  getFollowDiscoveryConfig,
  scrapeInstagramFollowingAccountsDetailed,
} from "@/lib/pipeline/follow-discovery";
import { runInstagramIngestion } from "@/lib/pipeline/run-instagram-ingestion";
import { getRequiredEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const syncFollowingSnapshotMutation =
  "instagramSources:syncFollowingSnapshot" as unknown as FunctionReference<"mutation">;
const recordFollowingFailureMutation =
  "instagramSources:recordFollowingFailure" as unknown as FunctionReference<"mutation">;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown following synchronization error.";
}

async function runFollowingSynchronization(request: NextRequest) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized cron request." }, { status: 401 });
  }

  const startedAt = Date.now();
  const config = getFollowDiscoveryConfig();
  const serviceSecret = getRequiredEnv("CONVEX_INGEST_SECRET");
  const client = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
  const scrapeRequest = buildApifyFollowingScrapeRequest(config);

  try {
    const scrape = await scrapeInstagramFollowingAccountsDetailed({ request: scrapeRequest });
    const synchronization = (await client.mutation(syncFollowingSnapshotMutation, {
      sourceHandle: config.sourceHandle,
      accounts: scrape.accounts.map((account) => ({
        handle: account.username,
        ...(typeof account.full_name === "string" && account.full_name.trim()
          ? { displayName: account.full_name.trim() }
          : typeof account.fullName === "string" && account.fullName.trim()
            ? { displayName: account.fullName.trim() }
            : {}),
        ...(typeof account.profileUrl === "string" && account.profileUrl.trim()
          ? { profileUrl: account.profileUrl.trim() }
          : typeof account.url === "string" && account.url.trim()
            ? { profileUrl: account.url.trim() }
            : {}),
      })),
      providerSucceeded: true,
      snapshotComplete: scrape.complete,
      rawItemCount: scrape.rawItemCount,
      malformedItemCount: scrape.malformedItemCount + scrape.duplicateItemCount,
      maxItems: scrapeRequest.runOptions.maxItems,
      startedAt,
      serviceSecret,
    })) as {
      complete: boolean;
      capped: boolean;
      discoveredCount: number;
      activatedCount: number;
      deactivatedCount: number;
      validItemCount: number;
      activatedHandles: string[];
    };

    const boundedBootstrapHandles = synchronization.activatedHandles.slice(0, 25);
    const ingestionSummary =
      boundedBootstrapHandles.length > 0
        ? await runInstagramIngestion({
            handles: boundedBootstrapHandles,
            mode: "full_scrape",
            resultsLimit: config.ingestionResultsLimit,
            daysBack: config.ingestionDaysBack,
            serviceSecret,
          })
        : null;

    return NextResponse.json({
      success: true,
      sourceHandle: config.sourceHandle,
      actorId: config.actorId,
      followingCount: scrape.accounts.length,
      snapshot: {
        complete: synchronization.complete,
        capped: synchronization.capped,
        rawItemCount: scrape.rawItemCount,
        validItemCount: synchronization.validItemCount,
        malformedItemCount: scrape.malformedItemCount,
        duplicateItemCount: scrape.duplicateItemCount,
      },
      sources: {
        discovered: synchronization.discoveredCount,
        activated: synchronization.activatedCount,
        deactivated: synchronization.deactivatedCount,
        bootstrapDeferred: Math.max(
          0,
          synchronization.activatedHandles.length - boundedBootstrapHandles.length,
        ),
      },
      bootstrap: {
        handles: boundedBootstrapHandles,
        ingestionSummary,
      },
      costControls: {
        followingResultsLimit: config.resultsLimit,
        followingMaxItems: scrapeRequest.runOptions.maxItems,
        followingMaxTotalChargeUsd: scrapeRequest.runOptions.maxTotalChargeUsd,
        followingTimeoutSeconds: scrapeRequest.runOptions.timeout,
        ingestionResultsLimit: config.ingestionResultsLimit,
        ingestionDaysBack: config.ingestionDaysBack,
      },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    try {
      await client.mutation(recordFollowingFailureMutation, {
        sourceHandle: config.sourceHandle,
        startedAt,
        error: message,
        serviceSecret,
      });
    } catch (recordError) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "instagram.following.failure_record_failed",
          error: getErrorMessage(recordError),
        }),
      );
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "instagram.following.sync_failed",
        sourceHandle: config.sourceHandle,
        error: message,
      }),
    );
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = runFollowingSynchronization;
export const POST = runFollowingSynchronization;
