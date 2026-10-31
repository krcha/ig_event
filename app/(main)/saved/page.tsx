import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import type { FunctionReference } from "convex/server";
import {
  SavedLibraryPanel,
  type SavedLibraryEvent,
  type SavedLibraryVenue,
} from "@/components/saved/saved-library-panel";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { getPublicTodayKey } from "@/lib/events/public-date";
import { resolveEventTimeDisplay } from "@/lib/events/event-time";
import { hasClerkEnv } from "@/lib/utils/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const metadata: Metadata = {
  title: "Saved events and venues",
  robots: { index: false, follow: false },
};

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

async function loadSavedLibrary(): Promise<LibraryResult & { upcomingEvents: SavedLibraryEvent[]; error?: string }> {
  const convex = await createAuthenticatedConvexHttpClient();
  const library = toLibraryResult(await convex.query(getMyLibraryQuery, {}));
  const venueQuery = "venues:getPublicVenuePage" as unknown as FunctionReference<"query">;
  const today = getPublicTodayKey();
  const upcomingEvents = library.savedEvents.filter(event => event.date >= today).map(withDisplayTime);
  let venueError: string | undefined;
  // Only favourite venues need a next-event lookup. Saved event bodies already
  // came from the authenticated library; never scan the whole city's 90 days.
  const ids = [...new Set(library.favoriteVenueIds)].slice(0, 100);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const result = await convex.query(venueQuery, { id, today, upcomingLimit: 1, historyLimit: 1 }) as { upcomingEvents?: unknown[] } | null;
        const event = result?.upcomingEvents?.find(isSavedEvent);
        if (event) upcomingEvents.push(withDisplayTime({ ...event, venueId: event.venueId ?? id }));
      } catch {
        venueError = "Some places' next events could not be loaded. Your saved events are available.";
      }
    }
  }));
  return { ...library, upcomingEvents, ...(venueError ? { error: venueError } : {}) };
}

function withDisplayTime(event: SavedLibraryEvent): SavedLibraryEvent {
  const display = resolveEventTimeDisplay({ date: event.date, time: event.time });
  return { ...event, dayPeriod: display.dayPeriod, displayTimeEnd: display.endLabel,
    displayTimeLabel: display.label, displayTimeSource: display.source, displayTimeStart: display.startLabel };
}

export default async function SavedPage({ searchParams }: { searchParams?: Promise<{ date?: string | string[] }> }) {
  const params = await searchParams;
  const date = Array.isArray(params?.date) ? params.date[0] : params?.date;
  const returnPath = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `/saved?date=${date}` : "/saved";
  const authEnabled = hasClerkEnv();
  const { userId } = authEnabled ? await auth() : { userId: null };
  let library = EMPTY_LIBRARY;
  let initialError: string | undefined;
  let upcomingEvents: SavedLibraryEvent[] = [];

  if (userId) {
    try {
      const result = await loadSavedLibrary();
      library = result;
      upcomingEvents = result.upcomingEvents;
      initialError = result.error;
    } catch (error) {
      initialError = error instanceof Error ? error.message : "Could not load saved items.";
    }
  }

  return (
    <main className="app-page gap-3 sm:gap-4">
      <SavedLibraryPanel
        authEnabled={authEnabled}
        initialError={initialError}
        initialFavoriteVenueIds={library.favoriteVenueIds}
        initialFavoriteVenues={library.favoriteVenues}
        initialSavedEventIds={library.savedEventIds}
        initialSavedEvents={library.savedEvents}
        upcomingEvents={upcomingEvents}
        returnPath={returnPath}
      />
    </main>
  );
}
