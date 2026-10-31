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
import {
  GUEST_SAVED_EVENT_PREFIX,
  readGuestSavedEvents,
  removeGuestSavedEventForOwner,
  syncGuestSavedEvents,
  writeGuestSavedEvent,
} from "@/lib/user-library/guest-saved-events";

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
  event?: unknown;
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
  isSignedIn: boolean;
  isSyncing: boolean;
  isVenuePending: (venueId: string) => boolean;
  refreshLibrary: () => Promise<void>;
  savedEventIds: ReadonlySet<string>;
  savedEvents: readonly LibraryEvent[];
  saveEvents: (eventIds: readonly string[], events?: readonly { _id: string }[]) => Promise<SaveEventsResult>;
  setSavedEvent: (eventId: string, saved: boolean, event?: unknown) => Promise<SetSavedEventResult>;
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
  isSignedIn: false,
  isSyncing: false,
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

type LibraryAuth = ReturnType<typeof useRequireAuth>;

function LibraryStateProvider({ children, identity }: { children: React.ReactNode; identity: Pick<LibraryAuth, "isLoaded" | "isSignedIn" | "requireAuth" | "userId"> }) {
  const { isLoaded, isSignedIn, requireAuth, userId } = identity;
  const [savedEventIds, setSavedEventIds] = useState<Set<string>>(new Set());
  const [favoriteVenueIds, setFavoriteVenueIds] = useState<Set<string>>(new Set());
  const [savedEvents, setSavedEvents] = useState<LibraryEvent[]>([]);
  const [favoriteVenues, setFavoriteVenues] = useState<LibraryVenue[]>([]);
  const [pendingSavedEventIds, setPendingSavedEventIds] = useState<Set<string>>(new Set());
  const [pendingFavoriteVenueIds, setPendingFavoriteVenueIds] = useState<Set<string>>(new Set());
  const [isLibraryLoaded, setIsLibraryLoaded] = useState(false);
  const [libraryUserId, setLibraryUserId] = useState<string | null | undefined>();
  const libraryOwnerRef = useRef(libraryUserId);
  libraryOwnerRef.current = libraryUserId;
  const [error, setError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [guestVersion, setGuestVersion] = useState(0);
  const syncingOwners = useRef(new Set<string>());
  const syncAgain = useRef(new Set<string>());
  const editClock = useRef(0);
  const confirmedEdits = useRef(new Map<string, { owner: string; saved: boolean; event: LibraryEvent | null; clock: number }>());
  const explicitIntent = useRef(new Map<string, boolean>());
  const authRef = useRef({ isLoaded, isSignedIn, userId });
  authRef.current = { isLoaded, isSignedIn, userId };
  const savedEventRequests = useRef(new Map<string, {
    promise: Promise<SetSavedEventResult>;
    saved: boolean;
  }>());

  const refreshLibrary = useCallback(async () => {
    if (!isSignedIn || !userId) {
      const guest = readGuestSavedEvents(window.localStorage);
      setSavedEventIds(new Set(guest.map(record => record.event._id)));
      setFavoriteVenueIds(new Set());
      setSavedEvents(guest.map(record => record.event));
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
    const startedAt = editClock.current;

    const response = await fetch("/api/user/library", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, "Could not load your saved items."));
    }

    const body = (await response.json()) as UserLibraryPayload;
    if (authRef.current.userId !== userId || !authRef.current.isSignedIn) return;
    let guest: ReturnType<typeof readGuestSavedEvents> = [];
    try { guest = readGuestSavedEvents(window.localStorage, userId); } catch { /* Account saves still work when device storage is blocked. */ }
    let nextIds = idsFromPayload(body.savedEventIds);
    let nextEvents = eventsFromPayload(body.savedEvents);
    for (const record of guest) {
      nextIds.add(record.event._id);
      if (!nextEvents.some(event => event._id === record.event._id)) nextEvents.push(record.event);
    }
    // A late GET must not undo a save/unsave confirmed after that read began.
    for (const [id, edit] of confirmedEdits.current) {
      if (edit.owner !== userId || edit.clock <= startedAt) continue;
      nextIds = toggleSetValue(nextIds, id, edit.saved);
      nextEvents = !edit.saved ? removeById(nextEvents, id) : edit.event ? upsertById(nextEvents, edit.event) : nextEvents;
    }
    setSavedEventIds(nextIds);
    setFavoriteVenueIds(idsFromPayload(body.favoriteVenueIds));
    setSavedEvents(nextEvents);
    setFavoriteVenues(venuesFromPayload(body.favoriteVenues));
    setLibraryUserId(userId);
    setIsLibraryLoaded(true);
  }, [isSignedIn, userId]);

  useEffect(() => {
    let isCancelled = false;

    async function loadLibrary() {
      try {
        await refreshLibrary();
      } catch (caughtError) {
        if (isCancelled || authRef.current.userId !== userId) {
          return;
        }
        if (libraryOwnerRef.current !== (isSignedIn ? userId : null)) {
          setSavedEventIds(new Set()); setSavedEvents([]);
          setFavoriteVenueIds(new Set()); setFavoriteVenues([]);
        }
        setLibraryUserId(isSignedIn ? userId : null);
        setIsLibraryLoaded(true);
        setError(caughtError instanceof Error ? caughtError.message : "Could not load your saved items.");
      }
    }

    void loadLibrary();

    return () => {
      isCancelled = true;
    };
  }, [refreshLibrary, userId, isSignedIn]);

  useEffect(() => {
    setPendingSavedEventIds(new Set());
    explicitIntent.current.clear();
    confirmedEdits.current.clear();
  }, [userId]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(GUEST_SAVED_EVENT_PREFIX)) return;
      if (authRef.current.isSignedIn) setGuestVersion(value => value + 1);
      else void refreshLibrary().catch(() => setError("Could not read saved events on this device."));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshLibrary]);

  const setSavedEvent = useCallback(
    (eventId: string, saved: boolean, snapshot?: unknown): Promise<SetSavedEventResult> => {
      const owner = authRef.current;
      if (!owner.isSignedIn || !owner.userId) {
        try {
          const event = writeGuestSavedEvent(window.localStorage, eventId, saved, snapshot);
          setSavedEventIds(current => toggleSetValue(current, eventId, saved));
          setSavedEvents(current => !saved ? removeById(current, eventId) : event ? upsertById(current, event) : current);
          setLibraryUserId(null);
          setIsLibraryLoaded(true);
          setError(null);
          return Promise.resolve({ authenticationRequired: false, error: null, event, eventId, saved, success: true });
        } catch {
          const message = "Could not save on this device. Check browser storage and try again.";
          setError(message);
          return Promise.resolve(failedSavedEventResult(eventId, message));
        }
      }
      const requestKey = `${owner.userId}:${eventId}`;
      explicitIntent.current.set(requestKey, saved);
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
          confirmedEdits.current.set(eventId, { owner: owner.userId!, event, saved, clock: ++editClock.current });
          if (!saved) {
            try { removeGuestSavedEventForOwner(window.localStorage, eventId, owner.userId!); } catch { /* An explicit retry remains safe. */ }
          }
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
    (eventIds: readonly string[], events: readonly { _id: string }[] = []) => {
      const byId = new Map(events.map(event => [event._id, event]));
      return saveEventSelection(eventIds, (id, saved) => setSavedEvent(id, saved, byId.get(id)));
    },
    [setSavedEvent],
  );

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId || !isLibraryLoaded || libraryUserId !== userId) return;
    if (syncingOwners.current.has(userId)) { syncAgain.current.add(userId); return; }
    const owner = userId;
    syncingOwners.current.add(owner);
    setIsSyncing(true);
    const currentOwner = () => authRef.current.isSignedIn && authRef.current.userId === owner;
    void Promise.resolve().then(() => syncGuestSavedEvents(window.localStorage, owner, id => setSavedEvent(id, true), currentOwner,
      id => explicitIntent.current.get(`${owner}:${id}`) !== false,
    )).then(result => {
      if (currentOwner() && result.failedEventIds.length) setError("Some device saves could not sync. Your local copies are kept. Try again.");
    }).catch(() => {
      if (currentOwner()) setError("Device saves could not sync. Your local copies are kept. Try again.");
    }).finally(() => {
      syncingOwners.current.delete(owner);
      if (!currentOwner()) return;
      setIsSyncing(false);
      if (syncAgain.current.delete(owner)) setGuestVersion(value => value + 1);
    });
  }, [guestVersion, isLibraryLoaded, isLoaded, isSignedIn, libraryUserId, setSavedEvent, userId]);

  const toggleSavedEvent = useCallback(
    async (eventId: string, options: ToggleSavedEventOptions = {}) => {
      const wasSaved = options.expectedSaved ?? savedEventIds.has(eventId);
      const result = await setSavedEvent(eventId, !wasSaved, options.event);
      return result.success ? result.saved : wasSaved;
    },
    [savedEventIds, setSavedEvent],
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

  const reloadLibrary = useCallback(async () => {
    const owner = authRef.current.userId;
    try { await refreshLibrary(); }
    catch {
      if (authRef.current.userId !== owner) return;
      if (libraryOwnerRef.current !== owner) {
        setSavedEventIds(new Set()); setSavedEvents([]); setFavoriteVenueIds(new Set()); setFavoriteVenues([]);
      }
      setLibraryUserId(owner); setIsLibraryLoaded(true);
      setError("Could not load saved items. Please try again.");
    }
  }, [refreshLibrary]);
  const matchingOwner = libraryUserId === (isSignedIn ? userId : null);

  const value = useMemo<UserLibraryContextValue>(
    () => ({
      error,
      favoriteVenueIds: matchingOwner ? favoriteVenueIds : emptySet,
      favoriteVenues: matchingOwner ? favoriteVenues : [],
      isEventPending: (eventId: string) => pendingSavedEventIds.has(eventId),
      isLibraryLoaded: isLibraryLoaded && libraryUserId === (isSignedIn ? userId : null),
      isSignedIn,
      isSyncing: isSignedIn && libraryUserId === userId && isSyncing,
      isVenuePending: (venueId: string) => pendingFavoriteVenueIds.has(venueId),
      refreshLibrary: reloadLibrary,
      savedEventIds: matchingOwner ? savedEventIds : emptySet,
      savedEvents: matchingOwner ? savedEvents : [],
      saveEvents,
      setSavedEvent,
      toggleFavoriteVenue,
      toggleSavedEvent,
      upcomingSavedEventCount: matchingOwner ? upcomingSavedEventCount : 0,
    }),
    [
      error,
      favoriteVenueIds,
      favoriteVenues,
      isLibraryLoaded,
      isSignedIn,
      isSyncing,
      libraryUserId,
      pendingFavoriteVenueIds,
      pendingSavedEventIds,
      refreshLibrary,
      reloadLibrary,
      matchingOwner,
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

function AuthenticatedUserLibraryProvider({ children }: { children: React.ReactNode }) {
  return <LibraryStateProvider identity={useRequireAuth()}>{children}</LibraryStateProvider>;
}

const guestIdentity = { isLoaded: true, isSignedIn: false, userId: null, requireAuth: () => false };

export function UserLibraryProvider({ children, authEnabled = true }: { children: React.ReactNode; authEnabled?: boolean }) {
  return authEnabled
    ? <AuthenticatedUserLibraryProvider>{children}</AuthenticatedUserLibraryProvider>
    : <LibraryStateProvider identity={guestIdentity}>{children}</LibraryStateProvider>;
}

export function useUserLibrary() {
  return useContext(UserLibraryContext);
}
