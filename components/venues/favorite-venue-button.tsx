"use client";

import { Heart } from "lucide-react";
import { useState } from "react";
import { useUserLibrary } from "@/components/providers/user-library-provider";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import { cn } from "@/lib/utils";

type FavoriteVenueButtonProps = {
  className?: string;
  defaultFavorite?: boolean;
  venueId?: string | null;
  venueName: string;
  variant?: "icon" | "inline" | "full";
};

export function FavoriteVenueButton({
  className,
  defaultFavorite = false,
  venueId,
  venueName,
  variant = "icon",
}: FavoriteVenueButtonProps) {
  const { isSignedIn } = useRequireAuth();
  const { error: libraryError, favoriteVenueIds, isLibraryLoaded, isVenuePending, toggleFavoriteVenue } =
    useUserLibrary();
  const [localError, setLocalError] = useState<string | null>(null);
  const isFavorite = venueId
    ? isLibraryLoaded
      ? favoriteVenueIds.has(venueId)
      : favoriteVenueIds.has(venueId) || defaultFavorite
    : false;
  const isBusy = venueId ? isVenuePending(venueId) : false;
  const label = isSignedIn
    ? `${isFavorite ? "Unfollow" : "Follow"} ${venueName}`
    : `Sign in to follow ${venueName}`;
  const displayLabel = isFavorite ? "Following" : "Follow";
  const error = localError ?? libraryError;

  async function onToggleFavoriteVenue() {
    setLocalError(null);
    if (!venueId) {
      setLocalError("This venue is not linked yet.");
      return;
    }
    if (isBusy) {
      return;
    }

    const result = await toggleFavoriteVenue(venueId, { expectedFavorite: isFavorite });
    if (result === null) {
      return;
    }
    if (result === isFavorite && !isBusy) {
      setLocalError("Could not update this venue.");
    }
  }

  return (
    <span className={cn("inline-flex flex-col items-stretch gap-1", className)}>
      <button
        aria-label={label}
        aria-pressed={isFavorite}
        className={cn(
          variant === "icon" &&
            "inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-border/75 bg-white/[0.035] text-muted-foreground hover:border-primary/35 hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
          variant === "inline" &&
            "inline-flex h-7 min-w-7 flex-none items-center justify-center rounded-full border border-border/70 bg-white/[0.035] px-1.5 text-muted-foreground hover:border-primary/35 hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
          variant === "full" &&
            "button-secondary min-h-11 gap-2 px-4 py-0 disabled:cursor-not-allowed disabled:opacity-60",
          isFavorite && "border-primary/35 bg-primary/[0.12] text-primary hover:bg-primary/[0.16] hover:text-primary",
          isBusy && "ring-1 ring-primary/35",
        )}
        data-auth-action="favorite-venue"
        data-favorite={isFavorite ? "true" : "false"}
        data-pending={isBusy ? "true" : "false"}
        data-venue-id={venueId ?? undefined}
        disabled={!venueId}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onToggleFavoriteVenue();
        }}
        type="button"
      >
        <Heart className={cn("h-4 w-4", isFavorite && "fill-current")} />
        {variant === "full" ? <span>{displayLabel}</span> : null}
      </button>
      {variant === "full" && error ? (
        <span className="text-xs leading-5 text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
