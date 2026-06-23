import { ConvexHttpClient } from "convex/browser";
import { NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/auth/admin-api";
import { runApprovedEventAutoMerge } from "@/lib/events/approved-event-automerge";
import { getRequiredEnv } from "@/lib/utils/env";

export const maxDuration = 180;

export async function POST() {
  try {
    const adminAccess = await requireAdminApiAccess();
    if (!adminAccess.ok) {
      return adminAccess.response;
    }

    const convex = new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"));
    const cleanupSummary = await runApprovedEventAutoMerge(convex);

    console.info(
      JSON.stringify({
        level: "info",
        event: "approved_events.auto_merge",
        approvedCount: cleanupSummary.approvedCount,
        scannedEventCount: cleanupSummary.scannedEventCount,
        duplicateGroupCount: cleanupSummary.duplicateGroupCount,
        mergedGroupCount: cleanupSummary.mergedGroupCount,
        mergedDuplicateCount: cleanupSummary.mergedDuplicateCount,
        remainingGroupCount: cleanupSummary.remainingGroupCount,
        failedCount: cleanupSummary.failedCount,
        passes: cleanupSummary.passes,
      }),
    );

    return NextResponse.json({
      ok: true,
      approvedCount: cleanupSummary.approvedCount,
      scannedEventCount: cleanupSummary.scannedEventCount,
      duplicateGroupCount: cleanupSummary.duplicateGroupCount,
      mergedGroupCount: cleanupSummary.mergedGroupCount,
      mergedDuplicateCount: cleanupSummary.mergedDuplicateCount,
      remainingGroupCount: cleanupSummary.remainingGroupCount,
      failures: cleanupSummary.failures,
      deletedCount: cleanupSummary.mergedDuplicateCount,
      skippedCount: cleanupSummary.remainingGroupCount,
      failedCount: cleanupSummary.failedCount,
      failedDeletes: cleanupSummary.failures.map((failure) => ({
        id: failure.primaryEventId,
        error: failure.error,
      })),
      passes: cleanupSummary.passes,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to merge approved event duplicates.",
      },
      { status: 500 },
    );
  }
}
