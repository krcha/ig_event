import {
  badUserApiRequest,
  callUserApiDependency,
  runUserApiHandler,
  type RequireUserApiAccess,
} from "@/lib/auth/user-api";

type SavedEventRequestBody = {
  eventId?: unknown;
  saved?: unknown;
};

type SavedEventResult = Record<string, unknown> & {
  saved?: unknown;
};

type SavedEventDataClient = {
  getEvent: (eventId: string) => Promise<unknown>;
  getLibrary: () => Promise<Record<string, unknown>>;
  toggleSavedEvent: (
    eventId: string,
    saved: boolean | undefined,
  ) => Promise<SavedEventResult>;
};

type SavedEventRouteDependencies = {
  createDataClient: () => Promise<SavedEventDataClient>;
  requireAccess: RequireUserApiAccess;
};

function getEventId(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("eventId" in body)) {
    return null;
  }

  const { eventId } = body as SavedEventRequestBody;
  return typeof eventId === "string" && eventId.length > 0 ? eventId : null;
}

function getSaved(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object" || !("saved" in body)) {
    return undefined;
  }

  const { saved } = body as SavedEventRequestBody;
  return typeof saved === "boolean" ? saved : undefined;
}

async function readRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return badUserApiRequest("Invalid JSON body.");
  }
}

export function createSavedEventRouteHandlers({
  createDataClient,
  requireAccess,
}: SavedEventRouteDependencies) {
  return {
    GET: () =>
      runUserApiHandler(requireAccess, async (userId) => {
        const client = await callUserApiDependency(createDataClient);
        const result = await callUserApiDependency(client.getLibrary);
        return { ...result, userId };
      }),
    POST: (request: Request) =>
      runUserApiHandler(requireAccess, async (userId) => {
        const body = await readRequestBody(request);
        const eventId = getEventId(body);
        if (!eventId) {
          return badUserApiRequest("A valid eventId is required.");
        }
        const saved = getSaved(body);

        const client = await callUserApiDependency(createDataClient);
        const result = await callUserApiDependency(
          () => client.toggleSavedEvent(eventId, saved),
          {
            notFoundErrorIncludes: "Approved event not found.",
            notFoundMessage: "Approved event not found.",
          },
        );
        const event = result.saved
          ? await callUserApiDependency(() => client.getEvent(eventId))
          : null;

        return { ...result, event, eventId, userId };
      }),
  };
}
