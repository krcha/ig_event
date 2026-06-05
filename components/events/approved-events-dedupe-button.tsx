"use client";

import { GitMerge, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ApprovedEventsDedupeButtonProps = {
  disabled?: boolean;
};

type MergeResponse = {
  ok?: boolean;
  error?: string;
  mergedGroupCount?: number;
  mergedDuplicateCount?: number;
  scannedEventCount?: number;
  duplicateGroupCount?: number;
  deletedCount?: number;
  skippedCount?: number;
  remainingGroupCount?: number;
  failedCount?: number;
  failures?: Array<{ id?: string; primaryEventId?: string; error: string }>;
  failedDeletes?: Array<{ id?: string; primaryEventId?: string; error: string }>;
};

export function ApprovedEventsDedupeButton({
  disabled = false,
}: ApprovedEventsDedupeButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isRefreshing, startRefresh] = useTransition();
  const isPending = isRunning || isRefreshing;

  async function handleMerge() {
    const confirmed = window.confirm(
      "Merge likely duplicate approved events?\n\nThis keeps the strongest event record, moves saved-event references onto it, and merges duplicate records into that primary when they share the same date, the same or similar venue, and matching title, description, or Instagram source text.",
    );
    if (!confirmed) {
      return;
    }

    setError(null);
    setMessage(null);
    setIsRunning(true);

    try {
      const response = await fetch("/api/admin/events/dedupe-approved", {
        method: "POST",
      });

      const responseText = await response.text();
      let payload: MergeResponse = {};
      try {
        payload = responseText ? (JSON.parse(responseText) as MergeResponse) : {};
      } catch {
        payload = {
          error: responseText.trim() || `Request failed with status ${response.status}.`,
        };
      }

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to merge approved duplicates.");
      }

      const mergedDuplicateCount = payload.mergedDuplicateCount ?? payload.deletedCount ?? 0;
      const duplicateGroupCount = payload.mergedGroupCount ?? payload.duplicateGroupCount ?? 0;
      const scannedEventCount = payload.scannedEventCount ?? 0;
      const reviewGroupCount = payload.remainingGroupCount ?? payload.skippedCount ?? 0;
      const failedCount = payload.failedCount ?? 0;
      const firstFailure = payload.failures?.[0] ?? payload.failedDeletes?.[0];
      const firstFailureId = firstFailure?.primaryEventId ?? firstFailure?.id ?? "unknown";

      setMessage(
        failedCount > 0
          ? mergedDuplicateCount > 0
            ? `Merged ${mergedDuplicateCount} duplicates from the approved list, left ${reviewGroupCount} groups for review, and hit ${failedCount} merge failure${failedCount === 1 ? "" : "s"}. First failure: ${firstFailureId}.`
            : `No duplicates were merged. ${failedCount} merge failure${failedCount === 1 ? "" : "s"}${firstFailure ? `, first: ${firstFailureId}` : ""}.`
          : mergedDuplicateCount > 0
            ? reviewGroupCount > 0
              ? `Merged ${mergedDuplicateCount} duplicates from ${duplicateGroupCount} groups and left ${reviewGroupCount} groups for review.`
              : `Merged ${mergedDuplicateCount} duplicates from ${duplicateGroupCount} approved-event groups.`
            : reviewGroupCount > 0
              ? `No groups were auto-merged. ${reviewGroupCount} duplicate group${reviewGroupCount === 1 ? "" : "s"} still need manual review across ${scannedEventCount} approved events.`
              : `No approved duplicate groups matched the merge rules across ${scannedEventCount} approved events.`,
      );

      startRefresh(() => {
        router.refresh();
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown approved-event merge error.",
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="flex max-w-sm flex-col gap-2 sm:items-end">
      <button
        className="inline-flex items-center justify-center gap-2 rounded-full border border-destructive/30 bg-destructive/10 px-5 py-2.5 text-sm font-semibold text-destructive hover:bg-destructive/14 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || isPending}
        onClick={() => void handleMerge()}
        type="button"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
        {isPending ? "Merging duplicates..." : "Merge duplicates"}
      </button>

      {error ? (
        <p className="text-sm text-destructive sm:text-right">{error}</p>
      ) : message ? (
        <p className="text-sm text-muted-foreground sm:text-right">{message}</p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground sm:text-right">
          Conservative merge: same date, same or similar venue, and matching title,
          description, or Instagram source.
        </p>
      )}
    </div>
  );
}
