"use client";

import { Bookmark } from "lucide-react";
import { useState } from "react";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { cn } from "@/lib/utils";

type SaveEventButtonProps = {
  className?: string;
  defaultSaved?: boolean;
  eventId: string;
  event?: unknown;
  eventTitle?: string;
  variant?: "icon" | "full";
};

export function SaveEventButton({
  className,
  defaultSaved = false,
  eventId,
  event,
  eventTitle,
  variant = "full",
}: SaveEventButtonProps) {
  const { error: libraryError, isEventPending, isLibraryLoaded, savedEventIds, toggleSavedEvent } =
    useUserLibrary();
  const [localError, setLocalError] = useState<string | null>(null);
  const isBusy = isEventPending(eventId);
  const isSaved = isLibraryLoaded ? savedEventIds.has(eventId) : savedEventIds.has(eventId) || defaultSaved;
  const actionLabel = isSaved ? "Unsave" : "Save";
  const label = `${actionLabel}${eventTitle ? ` ${eventTitle}` : " event"}`;
  const displayLabel = isSaved ? "Saved" : "Save";
  const error = localError ?? libraryError;

  async function onToggleSavedEvent() {
    setLocalError(null);
    if (isBusy) {
      return;
    }

    const result = await toggleSavedEvent(eventId, { expectedSaved: isSaved, event });
    if (result === null) {
      return;
    }
    if (result === isSaved && !isBusy) {
      setLocalError("Could not update this event.");
    }
  }

  return (
    <span className={cn("inline-flex flex-col items-stretch gap-1", className)}>
      <button
        aria-label={label}
        aria-pressed={isSaved}
        className={cn(
          variant === "icon"
            ? "inline-flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[12px] border border-white/[0.12] bg-white/[0.035] text-muted-foreground hover:border-[#D5F56B]/45 hover:bg-[#D5F56B]/[0.08] hover:text-[#D5F56B]"
            : "button-secondary min-h-11 gap-2 px-4 py-0",
          isSaved &&
            "border-transparent bg-[#D5F56B]/[0.14] text-[#D5F56B] hover:bg-[#D5F56B]/[0.18] hover:text-[#D5F56B]",
          isBusy && "ring-1 ring-[#D5F56B]/35",
        )}
        data-auth-action="save-event"
        data-save-event="true"
        data-pending={isBusy ? "true" : "false"}
        data-saved={isSaved ? "true" : "false"}
        onClick={(click) => {
          click.preventDefault();
          click.stopPropagation();
          void onToggleSavedEvent();
        }}
        type="button"
      >
        <Bookmark className={cn("h-4 w-4", isSaved ? "fill-[#D5F56B] text-[#D5F56B]" : "fill-transparent")} />
        {variant === "full" ? <span>{displayLabel}</span> : null}
      </button>
      {error ? (
        <span role="status" className={variant === "icon" ? "sr-only" : "text-xs leading-5 text-destructive"}>{error}</span>
      ) : null}
    </span>
  );
}
