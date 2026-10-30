"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRequireAuth } from "@/lib/auth/use-require-auth";
import {
  failedSavedEventResult,
  requestSavedEventState,
  saveEventSelection,
  type SaveEventsResult,
  type SetSavedEventResult,
} from "@/lib/user-library/saved-events-client";

type LibraryEvent = {
  _id: string;
  title?: string;
  date?: string;
  time?: string;
  venue?: string;
  venueId?: string;
  eventType?: string;
  ticketPrice?: string;
  attendance?: number | string;
  attendanceCount?: number | string;
  attendeeCount?: number | string;
  attendees?: number | string;
  attendeesCount?: number | string;
  going?: number | string;
  goingCount?: number | string;
  status?: string;
};

type LibraryVenue = {
  _id: string;
  name?: string;
  category?: string;
};

type UserLibraryPayload = {
  favoriteVenueIds?: unknown;
  favoriteVenues?: unknown;
  savedEventIds?: unknown;
  savedEvents?: unknown;
};

type ToggleFavoriteVenuePayload = {
  favorite?: unknown;
  venue?: unknown;
};

type ToggleSavedEventOptions = {
  expectedSaved?: boolean;
};

type ToggleFavoriteVenueOptions = {
  expectedFavorite?: boolean;
};

type UserLibraryContextValue = {
  error: string | null;
  favoriteVenueIds: ReadonlySet<string>;
  favoriteVenues: readonly LibraryVenue[];
  isEventPending: (eventId: string) => boolean;
  isLibraryLoaded: boolean;
  isVenuePending: (venueId: string) => boolean;
  refreshLibrary: () => Promise<void>;
  savedEventIds: ReadonlySet<string>;
  savedEvents: readonly LibraryEvent[];
  saveEvents: (eventIds: readonly string[]) => Promise<SaveEventsResult>;
  setSavedEvent: (eventId: string, saved: boolean) => Promise<SetSavedEventResult>;
  toggleFavoriteVenue: (
    venueId: string,
    options?: ToggleFavoriteVenueOptions,
  ) => Promise<boolean | null>;
  toggleSavedEvent: (eventId: string, options?: ToggleSavedEventOptions) => Promise<boolean | null>;
  upcomingSavedEventCount: number;
};

const emptySet = new Set<string>();

const UserLibraryContext = createContext<UserLibraryContextValue>({
  error: null,
  favoriteVenueIds: emptySet,
  favoriteVenues: [],
  isEventPending: () => false,
  isLibraryLoaded: false,
  isVenuePending: () => false,
  refreshLibrary: async () => {},
  savedEventIds: emptySet,
  savedEvents: [],
  saveEvents: async (eventIds) => ({
    authenticationRequired: true,
    failedEventIds: [...new Set(eventIds)],
    savedEventIds: [],
  }),
  setSavedEvent: async (eventId) => failedSavedEventResult(eventId, "Authentication required.", true),
  toggleFavoriteVenue: async () => null,
  toggleSavedEvent: async () => null,
  upcomingSavedEventCount: 0,
});

function idsFromPayload(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }

  return new Set(value.filter((item): item is string => typeof item === "string"));
}

function isRecordWithId(value: unknown): value is { _id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_id" in value &&
    typeof (value as { _id?: unknown })._id === "string"
  );
}

function eventsFromPayload(value: unknown): LibraryEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecordWithId) as LibraryEvent[];
}

function venuesFromPayload(value: unknown): LibraryVenue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecordWithId) as LibraryVenue[];
}

function eventFromPayload(value: unknown): LibraryEvent | null {
  return isRecordWithId(value) ? (value as LibraryEvent) : null;
}

function venueFromPayload(value: unknown): LibraryVenue | null {
  return isRecordWithId(value) ? (value as LibraryVenue) : null;
}

function toggleSetValue(values: ReadonlySet<string>, id: string, enabled: boolean): Set<string> {
  const next = new Set(values);
  if (enabled) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function upsertById<T extends { _id: string }>(items: readonly T[], item: T): T[] {
  const next = items.filter((existing) => existing._id !== item._id);
  next.push(item);
  return next;
}

function removeById<T extends { _id: string }>(items: readonly T[], id: string): T[] {
  return items.filter((item) => item._id !== id);
}

function formatLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function isUpcomingSavedEvent(event: LibraryEvent, activeIds: ReadonlySet<string>): boolean {
  if (!activeIds.has(event._id) || typeof event.date !== "string") {
    return false;
  }

  if (event.status && event.status !== "approved") {
    return false;
  }

  return event.date >= formatLocalDateKey(new Date());
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function UserLibraryProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, requireAuth, userId } = useRequireAuth();
  const [savedEventIds, setSavedEventIds] = useState<Set<string>>(new Set());
  const [favoriteVenueIds, setFavoriteVenueIds] = useState<Set<string>>(new Set());
  const [savedEvents, setSavedEvents] = useState<LibraryEvent[]>([]);
  const [favoriteVenues, setFavoriteVenues] = useState<LibraryVenue[]>([]);
  const [pendingSavedEventIds, setPendingSavedEventIds] = useState<Set<string>>(new Set());
  const [pendingFavoriteVenueIds, setPendingFavoriteVenueIds] = useState<Set<string>>(new Set());
  const [isLibraryLoaded, setIsLibraryLoaded] = useState(false);
  const [libraryUserId, setLibraryUserId] = useState<string | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const authRef = useRef({ isLoaded, isSignedIn, userId });
  authRef.current = { isLoaded, isSignedIn, userId };
  const savedEventRequests = useRef(new Map<string, {
    promise: Promise<SetSavedEventResult>;
    saved: boolean;
  }>());

  const refreshLibrary = useCallback(async () => {
    if (!isLoaded) {
      return;
    }

    if (!isSignedIn || !userId) {
      setSavedEventIds(new Set());
      setFavoriteVenueIds(new Set());
      setSavedEvents([]);
      setFavoriteVenues([]);
      setPendingSavedEventIds(new Set());
      setPendingFavoriteVenueIds(new Set());
      setLibraryUserId(null);
      setIsLibraryLoaded(true);
      setError(null);
      return;
    }

    setIsLibraryLoaded(false);
    setError(null);

    const response = await fetch("/api/user/library", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "Could not load your saved items."));
    }

    const body = (await response.json()) as UserLibraryPayload;
    if (authRef.current.userId !== userId || !authRef.current.isSignedIn) return;
    setSavedEventIds(idsFromPayload(body.savedEventIds));
    setFavoriteVenueIds(idsFromPayload(body.favoriteVenueIds));
    setSavedEvents(eventsFromPayload(body.savedEvents));
    setFavoriteVenues(venuesFromPayload(body.favoriteVenues));
    setLibraryUserId(userId);
    setIsLibraryLoaded(true);
  }, [isLoaded, isSignedIn, userId]);

  useEffect(() => {
    let isCancelled = false;

    async function loadLibrary() {
      try {
        await refreshLibrary();
      } catch (caughtError) {
        if (isCancelled || authRef.current.userId !== userId) {
          return;
        }
        setLibraryUserId(userId);
        setIsLibraryLoaded(true);
        setError(caughtError instanceof Error ? caughtError.message : "Could not load your saved items.");
      }
    }

    void loadLibrary();

    return () => {
      isCancelled = true;
    };
  }, [refreshLibrary, userId]);

  useEffect(() => {
    setPendingSavedEventIds(new Set());
  }, [userId]);

  const setSavedEvent = useCallback(
    (eventId: string, saved: boolean): Promise<SetSavedEventResult> => {
      const owner = authRef.current;
      if (!owner.isLoaded || !owner.isSignedIn || !owner.userId) {
        return Promise.resolve(failedSavedEventResult(eventId, "Authentication required.", true));
      }
      const requestKey = `${owner.userId}:${eventId}`;
      const previous = savedEventRequests.current.get(requestKey);
      if (previous?.saved === saved) return previous.promise;

      const promise = (async () => {
        if (previous) await previous.promise;
        if (!authRef.current.isSignedIn || authRef.current.userId !== owner.userId) {
          return failedSavedEventResult(eventId, "Authentication required.", true);
        }
        setError(null);
        setPendingSavedEventIds((current) => toggleSetValue(current, eventId, true));
        const result = await requestSavedEventState(eventId, saved);
        if (!authRef.current.isSignedIn || authRef.current.userId !== owner.userId) {
          return failedSavedEventResult(eventId, "Authentication required.", true);
        }
        if (result.success) {
          const event = eventFromPayload(result.event);
          setSavedEventIds((current) => toggleSetValue(current, eventId, saved));
          setSavedEvents((current) => !saved
            ? removeById(current, eventId)
            : event ? upsertById(current, event) : current);
        } else {
          setError(result.error);
        }
        setPendingSavedEventIds((current) => toggleSetValue(current, eventId, false));
        return result;
      })();
      savedEventRequests.current.set(requestKey, { promise, saved });
      void promise.then(() => {
        if (savedEventRequests.current.get(requestKey)?.promise === promise) {
          savedEventRequests.current.delete(requestKey);
        }
      });
      return promise;
    },
    [],
  );

  const saveEvents = useCallback(
    (eventIds: readonly string[]) => saveEventSelection(eventIds, setSavedEvent),
    [setSavedEvent],
  );

  const toggleSavedEvent = useCallback(
    async (eventId: string, options: ToggleSavedEventOptions = {}) => {
      if (!requireAuth()) return null;
      const wasSaved = options.expectedSaved ?? savedEventIds.has(eventId);
      const result = await setSavedEvent(eventId, !wasSaved);
      return result.success ? result.saved : wasSaved;
    },
    [requireAuth, savedEventIds, setSavedEvent],
  );

  const toggleFavoriteVenue = useCallback(
    async (venueId: string, options: ToggleFavoriteVenueOptions = {}) => {
      setError(null);
      if (!requireAuth()) {
        return null;
      }

      const wasFavorite = options.expectedFavorite ?? favoriteVenueIds.has(venueId);
      const previousFavoriteVenue = favoriteVenues.find((venue) => venue._id === venueId) ?? null;
      const optimisticFavorite = !wasFavorite;
      setFavoriteVenueIds((current) => toggleSetValue(current, venueId, optimisticFavorite));
      if (!optimisticFavorite) {
        setFavoriteVenues((current) => removeById(current, venueId));
      }
      setPendingFavoriteVenueIds((current) => toggleSetValue(current, venueId, true));

      try {
        const response = await fetch("/api/user/favorite-venues", {
          body: JSON.stringify({ favorite: optimisticFavorite, venueId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response, "Could not update this venue."));
        }

        const body = (await response.json()) as ToggleFavoriteVenuePayload;
        const favorite = typeof body.favorite === "boolean" ? body.favorite : optimisticFavorite;
        const venue = venueFromPayload(body.venue);
        setFavoriteVenueIds((current) => toggleSetValue(current, venueId, favorite));
        setFavoriteVenues((current) => {
          if (!favorite) {
            return removeById(current, venueId);
          }
          return venue ? upsertById(current, venue) : current;
        });
        return favorite;
      } catch (caughtError) {
        setFavoriteVenueIds((current) => toggleSetValue(current, venueId, wasFavorite));
        setFavoriteVenues((current) => {
          if (!wasFavorite) {
            return removeById(current, venueId);
          }
          return previousFavoriteVenue ? upsertById(current, previousFavoriteVenue) : current;
        });
        setError(caughtError instanceof Error ? caughtError.message : "Could not update this venue.");
        return wasFavorite;
      } finally {
        setPendingFavoriteVenueIds((current) => toggleSetValue(current, venueId, false));
      }
    },
    [favoriteVenueIds, favoriteVenues, requireAuth],
  );

  const upcomingSavedEventCount = useMemo(
    () => savedEvents.filter((event) => isUpcomingSavedEvent(event, savedEventIds)).length,
    [savedEventIds, savedEvents],
  );

  const value = useMemo<UserLibraryContextValue>(
    () => ({
      error,
      favoriteVenueIds,
      favoriteVenues,
      isEventPending: (eventId: string) => pendingSavedEventIds.has(eventId),
      isLibraryLoaded: isLibraryLoaded && libraryUserId === userId,
      isVenuePending: (venueId: string) => pendingFavoriteVenueIds.has(venueId),
      refreshLibrary,
      savedEventIds,
      savedEvents,
      saveEvents,
      setSavedEvent,
      toggleFavoriteVenue,
      toggleSavedEvent,
      upcomingSavedEventCount,
    }),
    [
      error,
      favoriteVenueIds,
      favoriteVenues,
      isLibraryLoaded,
      libraryUserId,
      pendingFavoriteVenueIds,
      pendingSavedEventIds,
      refreshLibrary,
      savedEventIds,
      savedEvents,
      saveEvents,
      setSavedEvent,
      toggleFavoriteVenue,
      toggleSavedEvent,
      upcomingSavedEventCount,
      userId,
    ],
  );

  return <UserLibraryContext.Provider value={value}>{children}</UserLibraryContext.Provider>;
}

export function useUserLibrary() {
  return useContext(UserLibraryContext);
}
