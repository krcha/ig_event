export type SetSavedEventResult = {
  authenticationRequired: boolean;
  error: string | null;
  event?: unknown;
  eventId: string;
  saved: boolean | null;
  success: boolean;
};

export type SaveEventsResult = {
  authenticationRequired: boolean;
  failedEventIds: string[];
  savedEventIds: string[];
};

export function failedSavedEventResult(
  eventId: string,
  error: string,
  authenticationRequired = false,
): SetSavedEventResult {
  return { authenticationRequired, error, eventId, saved: null, success: false };
}

// An explicit desired state makes interrupted requests safe to retry. A toggle
// would undo an earlier save when its response was lost.
export async function requestSavedEventState(
  eventId: string,
  saved: boolean,
  fetcher: typeof fetch = fetch,
): Promise<SetSavedEventResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher("/api/user/saved-events", {
      body: JSON.stringify({ eventId, saved }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    const body: { error?: unknown; event?: unknown; saved?: unknown } | null =
      await response.json().catch(() => null);
    if (!response.ok) {
      return failedSavedEventResult(
        eventId,
        typeof body?.error === "string" ? body.error : "Could not update this event.",
        response.status === 401,
      );
    }
    if (body?.saved !== saved) {
      return failedSavedEventResult(eventId, "Could not confirm this event was updated.");
    }
    return {
      authenticationRequired: false,
      error: null,
      event: body.event,
      eventId,
      saved,
      success: true,
    };
  } catch {
    return failedSavedEventResult(eventId, "Could not update this event. Please try again.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveEventSelection(
  eventIds: readonly string[],
  setSavedEvent: (eventId: string, saved: boolean) => Promise<SetSavedEventResult>,
): Promise<SaveEventsResult> {
  const ids = [...new Set(eventIds)];
  const saved = new Set<string>();
  let authenticationRequired = false;
  let cursor = 0;
  async function saveNext() {
    while (cursor < ids.length && !authenticationRequired) {
      const eventId = ids[cursor++];
      try {
        const result = await setSavedEvent(eventId, true);
        if (result.success && result.saved === true) saved.add(eventId);
        if (result.authenticationRequired) authenticationRequired = true;
      } catch {
        // Keep failed IDs available for an explicit retry, including a request
        // whose server response was lost after it committed.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, saveNext));
  return {
    authenticationRequired,
    failedEventIds: ids.filter(eventId => !saved.has(eventId)),
    savedEventIds: ids.filter(eventId => saved.has(eventId)),
  };
}
