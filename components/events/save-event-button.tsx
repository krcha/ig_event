"use client";

import { Bookmark } from "lucide-react";
import { useState } from "react";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { cn } from "@/lib/utils";

type SaveEventButtonProps = {
  className?: string;
  defaultSaved?: boolean;
  eventId: string;
  eventTitle?: string;
  variant?: "icon" | "full";
};

export function SaveEventButton({
  className,
  defaultSaved = false,
  eventId,
  eventTitle,
  variant = "full",
}: SaveEventButtonProps) {
  const { isSignedIn } = useRequireAuth();
  const { error: libraryError, isEventPending, isLibraryLoaded, savedEventIds, toggleSavedEvent } =
    useUserLibrary();
  const [localError, setLocalError] = useState<string | null>(null);
  const isBusy = isEventPending(eventId);
  const isSaved = isLibraryLoaded ? savedEventIds.has(eventId) : savedEventIds.has(eventId) || defaultSaved;
  const actionLabel = isSaved ? "Unsave" : "Save";
  const label = isSignedIn
    ? `${actionLabel}${eventTitle ? ` ${eventTitle}` : " event"}`
    : "Sign in to save";
  const displayLabel = isSaved ? "Saved" : "Save";
  const error = localError ?? libraryError;

  async function onToggleSavedEvent() {
    setLocalError(null);
    if (isBusy) {
      return;
    }

    const result = await toggleSavedEvent(eventId, { expectedSaved: isSaved });
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
            ? "inline-flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[12px] border border-white/[0.12] bg-white/[0.035] text-muted-foreground hover:border-[#8B86FB]/45 hover:bg-[#8B86FB]/[0.08] hover:text-[#8B86FB]"
            : "button-secondary min-h-11 gap-2 px-4 py-0",
          isSaved &&
            "border-transparent bg-[#8B86FB]/[0.14] text-[#8B86FB] hover:bg-[#8B86FB]/[0.18] hover:text-[#8B86FB]",
          isBusy && "ring-1 ring-[#8B86FB]/35",
        )}
        data-auth-action="save-event"
        data-pending={isBusy ? "true" : "false"}
        data-saved={isSaved ? "true" : "false"}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onToggleSavedEvent();
        }}
        type="button"
      >
        <Bookmark className={cn("h-4 w-4", isSaved ? "fill-[#8B86FB] text-[#8B86FB]" : "fill-transparent")} />
        {variant === "full" ? <span>{displayLabel}</span> : null}
      </button>
      {variant === "full" && error ? (
        <span className="text-xs leading-5 text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
