import { getApifyBudgetConfig, getBudgetDayKey, getIngestionBootstrapDays, isPaidIngestionEnabled } from "@/lib/pipeline/instagram-ingestion-durability";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { ConvexHttpClient } from "convex/browser";
import type { IngestionStep, IngestionSummary, PaidFetchLeaseResult, RunInstagramIngestionOptions } from "@/lib/pipeline/ingestion/contracts";
import { claimPaidFetchLeaseMutation, markPaidFetchRequestStartedMutation, recordPaidFetchWindowSaturationMutation, recordPaidFetchWindowSuccessMutation, releasePaidFetchLeaseMutation } from "@/lib/pipeline/ingestion/convex-bindings";
import { getOrCreateHandleSummary, markFreshFetchNotAttempted } from "@/lib/pipeline/ingestion/reporting";
import { getErrorMessage, getProviderAttemptCooldownMs, logError, normalizeDirectFullScrapeConcurrency, normalizeFullScrapeResultsLimit, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { getSourceIdentityKey, loadSavedScrapedPostsForHandle, persistScrapedPostsForHandle } from "@/lib/pipeline/ingestion/source-documents";
import { instagramSourceProviderAdapter } from "@/lib/pipeline/ingestion/source-provider";

export async function resolvePaidFetchLeaseAfterBacklogMaintenance(
  claim: () => Promise<PaidFetchLeaseResult>,
  maxMaintenanceBatches = 25,
): Promise<PaidFetchLeaseResult> {
  const boundedMaxBatches = Math.max(1, Math.min(100, Math.trunc(maxMaintenanceBatches)));
  for (let batch = 0; batch < boundedMaxBatches; batch += 1) {
    const lease = await claim();
    if (lease.reason !== "backlog_maintenance_incomplete") {
      return lease;
    }
  }
  throw new Error(
    `Saved-post backlog maintenance exceeded ${boundedMaxBatches} batches without reaching a stable claim decision.`,
  );
}

export async function fetchFreshPostsForHandlesInParallel(
  client: ConvexHttpClient,
  handles: string[],
  summary: IngestionSummary,
  options: Pick<RunInstagramIngestionOptions, "resultsLimit" | "daysBack" | "noAgeCutoff" | "skipPinnedPosts" | "ignoreCheckpoint" | "ignoreCooldown">,
  serviceSecret: string,
  workOwner: string,
): Promise<Record<string, InstagramScrapedPost[]>> {
  const postsByHandle: Record<string, InstagramScrapedPost[]> = {};
  let nextHandleIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextHandleIndex < handles.length) {
      const handle = handles[nextHandleIndex];
      nextHandleIndex += 1;

      let fetchLeaseClaimed = false;
      let providerRequestStarted = false;
      const paidFetchLeaseOwner = `${workOwner}:apify:${handle}`.slice(0, 200);
      try {
        const baseResultsLimit = normalizeFullScrapeResultsLimit(options.resultsLimit);
        const fetchStartedAt = Date.now();
        const budget = getApifyBudgetConfig();
        const lease = await resolvePaidFetchLeaseAfterBacklogMaintenance(
          async () =>
            (await client.mutation(
              claimPaidFetchLeaseMutation,
              withServiceSecret(
                {
                  handle,
                  owner: paidFetchLeaseOwner,
                  leaseMs: 10 * 60_000,
                  requestedResultsLimit: baseResultsLimit,
                  fetchStartedAt,
                  bootstrapDays: getIngestionBootstrapDays(),
                  dayKey: getBudgetDayKey(new Date(fetchStartedAt)),
                  dailyBudgetUsd: budget.dailyBudgetMicros / 1_000_000,
                  maxChargeUsd: budget.maxChargePerHandleMicros / 1_000_000,
                  attemptCooldownMs: options.ignoreCooldown ? 0 : getProviderAttemptCooldownMs(),
                  requestBoundaryVersion: 1,
                  ...(!options.noAgeCutoff && options.daysBack && options.daysBack > 0
                    ? { horizonCutoffMs: fetchStartedAt - options.daysBack * 86_400_000 }
                    : {}),
                  paidEnabled: isPaidIngestionEnabled(),
                },
                serviceSecret,
              ),
            )) as PaidFetchLeaseResult,
        );
        if (!lease.claimed) {
          const handleSummary = getOrCreateHandleSummary(summary, handle);
          const denialReason = lease.reason ?? "unknown";
          markFreshFetchNotAttempted(
            summary,
            handle,
            denialReason,
            denialReason !== "recent_provider_attempt",
          );
          if (denialReason === "hard_cap_saturated") {
            handleSummary.fetchHardBlocked = (handleSummary.fetchHardBlocked ?? 0) + 1;
          }
          continue;
        }
        fetchLeaseClaimed = true;

        const onlyPostsNewerThan = lease.onlyPostsNewerThan ?? null;
        const requestedResultsLimit = normalizeFullScrapeResultsLimit(
          lease.resultsLimit ?? baseResultsLimit,
        );
        const sourceBatch = await instagramSourceProviderAdapter.fetchDocuments({
          handle,
          resultsLimit: requestedResultsLimit,
          daysBack: options.daysBack,
          noAgeCutoff: options.noAgeCutoff,
          skipPinnedPosts: options.skipPinnedPosts,
          onlyPostsNewerThan: onlyPostsNewerThan ?? undefined,
          abortAtMs: lease.expiresAt ? lease.expiresAt - 60_000 : undefined,
          onRequestStarted: async () => {
            await client.mutation(
              markPaidFetchRequestStartedMutation,
              withServiceSecret(
                { handle, owner: paidFetchLeaseOwner },
                serviceSecret,
              ),
            );
          },
          onTransportInvoked: () => {
            providerRequestStarted = true;
            const fetchSummary = getOrCreateHandleSummary(summary, handle);
            fetchSummary.freshFetchAttempted =
              (fetchSummary.freshFetchAttempted ?? 0) + 1;
          },
        });
        const posts = sourceBatch.documents.map((sourceDocument) =>
          instagramSourceProviderAdapter.projectForCompatibilityParser(sourceDocument),
        );
        const rawItemCount = sourceBatch.rawDocumentCount;
        const saturated = rawItemCount >= requestedResultsLimit;
        let saturation: { nextResultsLimit?: number; hardBlocked?: boolean } | null = null;

        try {
          // Persist every provider item before evaluating completeness. Saturated
          // windows remain checkpoint-incomplete, but their posts are still durable
          // and can be processed before another paid request.
          await persistScrapedPostsForHandle(
            client,
            handle,
            posts,
            serviceSecret,
            paidFetchLeaseOwner,
          );
          if (saturated) {
            saturation = (await client.mutation(
              recordPaidFetchWindowSaturationMutation,
              withServiceSecret(
                { handle, owner: paidFetchLeaseOwner, rawItemCount },
                serviceSecret,
              ),
            )) as { nextResultsLimit?: number; hardBlocked?: boolean };
          } else {
            await client.mutation(
              recordPaidFetchWindowSuccessMutation,
              withServiceSecret(
                { handle, owner: paidFetchLeaseOwner },
                serviceSecret,
              ),
            );
          }
        } catch (persistError) {
          logError("ingestion.scrape.persist_failed", {
            step: "fetch_posts" satisfies IngestionStep,
            handle,
            sourcePostId: null,
            shortcode: null,
            instagramUrl: null,
            error: getErrorMessage(persistError),
          });
          throw persistError;
        }

        if (saturated) {
          const continuationSummary = getOrCreateHandleSummary(summary, handle);
          continuationSummary.fetchContinuations =
            (continuationSummary.fetchContinuations ?? 0) + 1;
          if (saturation?.hardBlocked) {
            continuationSummary.fetchHardBlocked =
              (continuationSummary.fetchHardBlocked ?? 0) + 1;
            continuationSummary.errors.push(
              `Apify fetch window for @${handle} reached the configured maximum at ` +
                `${requestedResultsLimit} items. All returned posts were persisted, the ` +
                "checkpoint stayed unchanged, and operator review is required.",
            );
          }
        }

        const fetchedSourceIdentities = new Set(
          sourceBatch.documents.map((document) => document.sourceIdentity),
        );
        const actionableSavedPosts = await loadSavedScrapedPostsForHandle(
          client,
          handle,
          undefined,
          undefined,
          serviceSecret,
        );
        const freshPosts = actionableSavedPosts.filter((post) => {
          const sourceIdentity = getSourceIdentityKey(post);
          return sourceIdentity
            ? fetchedSourceIdentities.has(sourceIdentity)
            : false;
        });
        const skippedCount = Math.max(0, posts.length - freshPosts.length);

        const handleSummary = getOrCreateHandleSummary(summary, handle);
        handleSummary.fetchedPosts = posts.length;
        handleSummary.fetched_posts = posts.length;
        handleSummary.newFetchedPosts = freshPosts.length;
        handleSummary.skippedAlreadyFetchedPosts = skippedCount;
        handleSummary.apifyHighWatermarkApplied = onlyPostsNewerThan ? 1 : 0;

        postsByHandle[handle] = freshPosts;
      } catch (error) {
        const message = getErrorMessage(error);
        const handleSummary = getOrCreateHandleSummary(summary, handle);
        if (handleSummary.freshFetchAttempted === undefined) {
          handleSummary.freshFetchAttempted = providerRequestStarted ? 1 : 0;
        }
        handleSummary.errors.push(message);
        logError("ingestion.scrape.failed", {
          step: "fetch_posts" satisfies IngestionStep,
          handle,
          sourcePostId: null,
          shortcode: null,
          instagramUrl: null,
          error: message,
        });
      } finally {
        if (fetchLeaseClaimed) {
          try {
            await client.mutation(
              releasePaidFetchLeaseMutation,
              withServiceSecret(
                {
                  owner: paidFetchLeaseOwner,
                  requestStarted: providerRequestStarted,
                },
                serviceSecret,
              ),
            );
          } catch (error) {
            logError("ingestion.scrape.fetch_lease_release_failed", {
              step: "fetch_posts" satisfies IngestionStep,
              handle,
              sourcePostId: null,
              shortcode: null,
              instagramUrl: null,
              error: getErrorMessage(error),
            });
          }
        }
      }
    }
  }

  const workerCount = Math.min(normalizeDirectFullScrapeConcurrency(), handles.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker()),
  );

  return postsByHandle;
}
