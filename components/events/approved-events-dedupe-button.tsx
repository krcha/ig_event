"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ApprovedEventsDedupeButtonProps = {
  disabled?: boolean;
};

type CleanupResponse = {
  ok?: boolean;
  error?: string;
  scannedEventCount?: number;
  duplicateGroupCount?: number;
  deletedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  failedDeletes?: Array<{ id: string; error: string }>;
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

  async function handleCleanup() {
    const confirmed = window.confirm(
      "Delete likely duplicate approved events?\n\nThis keeps the strongest event record and removes approved duplicates when they share the same date, the same or similar venue, and matching title, description, or Instagram source text.",
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
      let payload: CleanupResponse = {};
      try {
        payload = responseText ? (JSON.parse(responseText) as CleanupResponse) : {};
      } catch {
        payload = {
          error: responseText.trim() || `Request failed with status ${response.status}.`,
        };
      }

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to delete approved duplicates.");
      }

      const deletedCount = payload.deletedCount ?? 0;
      const duplicateGroupCount = payload.duplicateGroupCount ?? 0;
      const scannedEventCount = payload.scannedEventCount ?? 0;
      const skippedCount = payload.skippedCount ?? 0;
      const failedCount = payload.failedCount ?? 0;
      const firstFailure = payload.failedDeletes?.[0];

      setMessage(
        failedCount > 0
          ? deletedCount > 0
            ? `Removed ${deletedCount} duplicates from the approved list, skipped ${skippedCount}, and hit ${failedCount} failure${failedCount === 1 ? "" : "s"}. First failure: ${firstFailure?.id ?? "unknown"}.`
            : `No duplicates were removed. ${failedCount} update failure${failedCount === 1 ? "" : "s"}${firstFailure ? `, first: ${firstFailure.id}` : ""}.`
          : deletedCount > 0
            ? skippedCount > 0
              ? `Removed ${deletedCount} duplicates from ${duplicateGroupCount} groups and skipped ${skippedCount} stale records.`
              : `Removed ${deletedCount} duplicates from ${duplicateGroupCount} approved-event groups.`
            : `No duplicates matched the cleanup rules across ${scannedEventCount} approved events.`,
      );

      startRefresh(() => {
        router.refresh();
      });
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Unknown approved-event cleanup error.",
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
        onClick={() => void handleCleanup()}
        type="button"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        {isPending ? "Cleaning duplicates..." : "Delete duplicates"}
      </button>

      {error ? (
        <p className="text-sm text-destructive sm:text-right">{error}</p>
      ) : message ? (
        <p className="text-sm text-muted-foreground sm:text-right">{message}</p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground sm:text-right">
          Conservative cleanup: same date, same or similar venue, and matching title,
          description, or Instagram source.
        </p>
      )}
    </div>
  );
}
