import { randomUUID } from "node:crypto";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import {
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
} from "@/convex/legacyDefinitiveOutputRecoveryAllowlist";
import {
  DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
} from "@/lib/ai/openai-analysis-protocol";
import { createConvexHttpClient, requireServiceSecret } from "@/lib/convex/server";
import { isAuthorizedCronRequestHeader } from "@/lib/pipeline/cron-ingestion-config";
import {
  isDurableSavedPostRevisionMismatch,
  isTransientSavedPostProcessingError,
} from "@/lib/pipeline/durable-ingestion-execute";
import { processSavedScrapedPostForDurableReceipt } from "@/lib/pipeline/run-instagram-ingestion";

export const dynamic = "force-dynamic";
// Three selected posts can each spend up to 120s in OpenAI after bounded
// remote-media preparation. The self-hosted recovery invocation therefore
// gets an explicit 20-minute ceiling instead of inheriting the 300s worker
// route limit.
export const maxDuration = 1_200;

const MAX_SELECTED_RECEIPTS = 3;
const MAX_OPENAI_TRANSPORT_ATTEMPTS = 3;
const initialReceiptIds = new Set<string>(
  LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_RECEIPT_IDS,
);

const claimExactRecovery =
  "durableIngestionRuns:claimLegacyDefinitiveOutputRecoveryReceipt" as unknown as FunctionReference<"mutation">;
const completeProcessing =
  "durableIngestionRuns:completeProcessingReceipt" as unknown as FunctionReference<"mutation">;
const releaseProcessing =
  "durableIngestionRuns:releaseProcessingReceiptForRetry" as unknown as FunctionReference<"mutation">;

type ExactRecoveryClaim = {
  claimed: boolean;
  state: "claimed" | "already_terminal" | "transport_ambiguous";
  runId: string;
  receiptId: string;
  handle: string;
  scrapedPostId: string;
  scrapedPostSourceRevision: number;
  processingAttemptCount: number;
  providerAttemptCount: number;
};

type ReleaseResult = {
  terminal: boolean;
  status: "processing_pending" | "fetched" | "no_post" | "deferred" | "failed";
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function readSelection(request: Request): Promise<{
  receiptIds: string[];
  legacyManifestVersion: typeof LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION;
  selectionSha256: typeof LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256;
  selectionVersion: typeof LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION;
} | null> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "receiptIds",
          "legacyManifestVersion",
          "selectionSha256",
          "selectionVersion",
        ].includes(key),
    ) ||
    body.legacyManifestVersion !==
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION ||
    body.selectionSha256 !==
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256 ||
    body.selectionVersion !==
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION ||
    !Array.isArray(body.receiptIds)
  ) {
    return null;
  }
  const receiptIds = body.receiptIds;
  if (
    receiptIds.length < 1 ||
    receiptIds.length > MAX_SELECTED_RECEIPTS ||
    receiptIds.some(
      (receiptId) =>
        typeof receiptId !== "string" ||
        !initialReceiptIds.has(receiptId),
    ) ||
    new Set(receiptIds).size !== receiptIds.length
  ) {
    return null;
  }
  return {
    receiptIds: receiptIds as string[],
    legacyManifestVersion: LEGACY_DEFINITIVE_OUTPUT_RECOVERY_MANIFEST_VERSION,
    selectionSha256:
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_SHA256,
    selectionVersion:
      LEGACY_DEFINITIVE_OUTPUT_RECOVERY_INITIAL_SELECTION_VERSION,
  };
}

/** Processing-only, exact-ID recovery. This module intentionally has no paid
 * Instagram provider import or fetch-claim reference. */
export async function POST(request: Request) {
  if (!isAuthorizedCronRequestHeader(request.headers.get("authorization"))) {
    return jsonError("Unauthorized recovery request.", 401);
  }
  const selection = await readSelection(request);
  if (!selection) {
    return jsonError(
      "A frozen selection SHA and one to three unique initial-selection receipt IDs are required.",
      400,
    );
  }

  const serviceSecret = requireServiceSecret();
  const convex = createConvexHttpClient();
  const batchOwner = `vps:legacy-output-recovery:${randomUUID()}`;
  let transportAttemptCount = 0;
  const results: Array<Record<string, unknown>> = [];

  const unknownStateResponse = (receiptId: string, stage: string, error: unknown) =>
    NextResponse.json(
      {
        selectedCount: selection.receiptIds.length,
        processedCount: results.length,
        transportAttemptCount,
        maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
        stopped: true,
        stopReason: "durable_state_unknown",
        receiptId,
        stage,
        error:
          error instanceof Error
            ? error.message.slice(0, 512)
            : "unknown recovery executor failure",
        results,
      },
      { status: 202 },
    );

  for (let ordinal = 0; ordinal < selection.receiptIds.length; ordinal += 1) {
    const receiptId = selection.receiptIds[ordinal];
    const workerId = `${batchOwner}:${ordinal}`.slice(0, 200);
    let claim: ExactRecoveryClaim;
    try {
      claim = (await convex.mutation(claimExactRecovery, {
        selectedReceiptIds: selection.receiptIds,
        receiptId,
        workerId,
        legacyManifestVersion: selection.legacyManifestVersion,
        selectionSha256: selection.selectionSha256,
        selectionVersion: selection.selectionVersion,
        recoveryProtocol: DEFINITIVE_OUTPUT_RECOVERY_PROTOCOL,
        serviceSecret,
      })) as ExactRecoveryClaim;
    } catch (error) {
      // A mutation acknowledgement can be lost after commit. Never try another
      // target while exact claim state is unknown; a later invocation can use
      // the expired-lease/readback reconciliation in the claim mutation.
      return unknownStateResponse(receiptId, "claim", error);
    }

    if (!claim.claimed) {
      results.push({
        receiptId,
        state: claim.state,
        transportAttempted: false,
        providerAttemptCount: claim.providerAttemptCount,
      });
      if (claim.state === "transport_ambiguous") {
        return NextResponse.json({
          selectedCount: selection.receiptIds.length,
          processedCount: results.length,
          transportAttemptCount,
          maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
          stopped: true,
          stopReason: "transport_ambiguous",
          results,
        }, { status: 202 });
      }
      continue;
    }

    let targetTransportAttempted = false;
    const onOpenAiTransportStarted = () => {
      if (targetTransportAttempted) {
        throw new Error("A recovery target attempted more than one OpenAI transport.");
      }
      if (transportAttemptCount >= MAX_OPENAI_TRANSPORT_ATTEMPTS) {
        throw new Error("The recovery batch reached its three-transport ceiling.");
      }
      // This callback runs before the extractor marks transportStarted and
      // before fetch(), so rejecting here is a definitely-unsent attempt.
      targetTransportAttempted = true;
      transportAttemptCount += 1;
    };

    let processingResult: Awaited<
      ReturnType<typeof processSavedScrapedPostForDurableReceipt>
    >;
    try {
      processingResult = await processSavedScrapedPostForDurableReceipt({
        handle: claim.handle,
        scrapedPostId: claim.scrapedPostId,
        expectedSourceRevision: claim.scrapedPostSourceRevision,
        workOwner: workerId,
        serviceSecret,
        onOpenAiTransportStarted,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "unknown saved-post recovery failure";
      try {
        await convex.mutation(releaseProcessing, {
          runId: claim.runId,
          receiptId: claim.receiptId,
          workerId,
          reason,
          retryAfterMs: isDurableSavedPostRevisionMismatch(error)
            ? 6 * 60 * 60_000
            : 30_000,
          ...(isDurableSavedPostRevisionMismatch(error) ||
          isTransientSavedPostProcessingError(error)
            ? { preserveAttempt: true }
            : {}),
          serviceSecret,
        });
      } catch (releaseError) {
        return unknownStateResponse(receiptId, "processing_release", releaseError);
      }
      results.push({ receiptId, state: "processing_error", transportAttempted: targetTransportAttempted });
      return NextResponse.json({
        selectedCount: selection.receiptIds.length,
        processedCount: results.length,
        transportAttemptCount,
        maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
        stopped: true,
        stopReason: "processing_error",
        results,
      }, { status: 202 });
    }

    if (processingResult.transportAttempted !== targetTransportAttempted) {
      return unknownStateResponse(
        receiptId,
        "transport_accounting",
        new Error("Recovery transport callback and processing result disagree."),
      );
    }

    if (processingResult.state === "terminal") {
      try {
        const completion = (await convex.mutation(completeProcessing, {
          runId: claim.runId,
          receiptId: claim.receiptId,
          workerId,
          detail: `saved_post:${claim.scrapedPostId};${processingResult.outcome}`,
          serviceSecret,
        })) as { status: "fetched" | "failed"; processingOutcome: string };
        results.push({
          receiptId,
          state: "terminal",
          status: completion.status,
          processingOutcome: completion.processingOutcome,
          transportAttempted: targetTransportAttempted,
        });
        continue;
      } catch (completionError) {
        // Read back through the idempotent release boundary. If completion
        // committed but its acknowledgement was lost, release reports the
        // already-terminal receipt without modifying it.
        try {
          const released = (await convex.mutation(releaseProcessing, {
            runId: claim.runId,
            receiptId: claim.receiptId,
            workerId,
            reason: "legacy recovery completion acknowledgement unavailable",
            serviceSecret,
          })) as ReleaseResult;
          if (released.terminal) {
            results.push({
              receiptId,
              state: "terminal_readback",
              status: released.status,
              transportAttempted: targetTransportAttempted,
            });
            continue;
          }
          results.push({
            receiptId,
            state: "completion_released",
            status: released.status,
            transportAttempted: targetTransportAttempted,
          });
          return NextResponse.json({
            selectedCount: selection.receiptIds.length,
            processedCount: results.length,
            transportAttemptCount,
            maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
            stopped: true,
            stopReason: "completion_not_terminal",
            results,
          }, { status: 202 });
        } catch (readbackError) {
          return unknownStateResponse(receiptId, "completion_readback", readbackError);
        }
      }
    }

    const reason = processingResult.reason;
    const preserveAttempt =
      isDurableSavedPostRevisionMismatch(reason) ||
      (processingResult.state === "pending" &&
        isTransientSavedPostProcessingError(reason));
    let released: ReleaseResult;
    try {
      released = (await convex.mutation(releaseProcessing, {
        runId: claim.runId,
        receiptId: claim.receiptId,
        workerId,
        reason,
        retryAfterMs: isDurableSavedPostRevisionMismatch(reason)
          ? 6 * 60 * 60_000
          : processingResult.state === "pending"
            ? processingResult.retryAfterMs
            : 30_000,
        ...(preserveAttempt ? { preserveAttempt: true } : {}),
        serviceSecret,
      })) as ReleaseResult;
    } catch (firstReleaseError) {
      try {
        released = (await convex.mutation(releaseProcessing, {
          runId: claim.runId,
          receiptId: claim.receiptId,
          workerId,
          reason,
          retryAfterMs: 30_000,
          ...(preserveAttempt ? { preserveAttempt: true } : {}),
          serviceSecret,
        })) as ReleaseResult;
      } catch (secondReleaseError) {
        return unknownStateResponse(receiptId, "processing_release_readback", secondReleaseError);
      }
    }
    results.push({
      receiptId,
      state: processingResult.state,
      status: released.status,
      reason,
      transportAttempted: targetTransportAttempted,
    });
    return NextResponse.json({
      selectedCount: selection.receiptIds.length,
      processedCount: results.length,
      transportAttemptCount,
      maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
      stopped: true,
      stopReason: processingResult.state,
      results,
    }, { status: 202 });
  }

  return NextResponse.json({
    selectedCount: selection.receiptIds.length,
    processedCount: results.length,
    transportAttemptCount,
    maxTransportAttemptCount: MAX_OPENAI_TRANSPORT_ATTEMPTS,
    stopped: false,
    results,
  });
}
