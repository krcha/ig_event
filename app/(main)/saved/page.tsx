import { auth } from "@clerk/nextjs/server";
import type { FunctionReference } from "convex/server";
import {
  SavedLibraryPanel,
  type SavedLibraryEvent,
  type SavedLibraryVenue,
} from "@/components/saved/saved-library-panel";
import { loadUpcomingApprovedEvents } from "@/lib/events/public-events";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { hasClerkEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type LibraryResult = {
  favoriteVenueIds: string[];
  favoriteVenues: SavedLibraryVenue[];
  savedEventIds: string[];
  savedEvents: SavedLibraryEvent[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSavedEvent(value: unknown): value is SavedLibraryEvent {
  const candidate = value as Partial<SavedLibraryEvent>;
  return (
    typeof candidate?._id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.date === "string" &&
    typeof candidate.venue === "string" &&
    typeof candidate.eventType === "string"
  );
}

function isSavedVenue(value: unknown): value is SavedLibraryVenue {
  const candidate = value as Partial<SavedLibraryVenue>;
  return typeof candidate?._id === "string" && typeof candidate.name === "string";
}

function toLibraryResult(value: unknown): LibraryResult {
  const candidate = value as Partial<LibraryResult>;
  return {
    favoriteVenueIds: isStringArray(candidate.favoriteVenueIds) ? candidate.favoriteVenueIds : [],
    favoriteVenues: Array.isArray(candidate.favoriteVenues)
      ? candidate.favoriteVenues.filter(isSavedVenue)
      : [],
    savedEventIds: isStringArray(candidate.savedEventIds) ? candidate.savedEventIds : [],
    savedEvents: Array.isArray(candidate.savedEvents) ? candidate.savedEvents.filter(isSavedEvent) : [],
  };
}

const EMPTY_LIBRARY: LibraryResult = {
  favoriteVenueIds: [],
  favoriteVenues: [],
  savedEventIds: [],
  savedEvents: [],
};

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;

async function loadSavedLibrary(): Promise<LibraryResult> {
  const convex = await createAuthenticatedConvexHttpClient();
  return toLibraryResult(await convex.query(getMyLibraryQuery, {}));
}

export default async function SavedPage() {
  if (!hasClerkEnv()) {
    return (
      <main className="app-page gap-3 sm:gap-4">
        <section className="hero-panel px-4 py-8 text-center sm:px-6">
          <p className="section-kicker">Saved</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.045em] sm:text-4xl">
            Clerk is not configured.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY to enable saved
            events and favourite places.
          </p>
        </section>
      </main>
    );
  }

  const { userId } = await auth();
  let library = EMPTY_LIBRARY;
  let initialError: string | undefined;
  let upcomingEvents: SavedLibraryEvent[] = [];

  if (userId) {
    const [libraryResult, upcomingResult] = await Promise.allSettled([
      loadSavedLibrary(),
      loadUpcomingApprovedEvents({ daysAhead: 90 }),
    ]);

    if (libraryResult.status === "fulfilled") {
      library = libraryResult.value;
    } else {
      initialError =
        libraryResult.reason instanceof Error
          ? libraryResult.reason.message
          : "Could not load saved items.";
    }

    if (upcomingResult.status === "fulfilled") {
      upcomingEvents = upcomingResult.value.events.filter(isSavedEvent);
      initialError = initialError ?? upcomingResult.value.error;
    } else {
      initialError = initialError ?? "Could not load upcoming events.";
    }
  }

  return (
    <main className="app-page gap-3 sm:gap-4">
      <SavedLibraryPanel
        initialError={initialError}
        initialFavoriteVenueIds={library.favoriteVenueIds}
        initialFavoriteVenues={library.favoriteVenues}
        initialSavedEventIds={library.savedEventIds}
        initialSavedEvents={library.savedEvents}
        upcomingEvents={upcomingEvents}
      />
    </main>
  );
}
