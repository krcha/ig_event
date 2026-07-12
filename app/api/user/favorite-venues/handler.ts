import {
  badUserApiRequest,
  callUserApiDependency,
  runUserApiHandler,
  type RequireUserApiAccess,
} from "@/lib/auth/user-api";

type FavoriteVenueRequestBody = {
  favorite?: unknown;
  venueId?: unknown;
};

type FavoriteVenueResult = Record<string, unknown> & {
  favorite?: unknown;
};

type FavoriteVenueDataClient = {
  getLibrary: () => Promise<Record<string, unknown>>;
  getVenues: (venueIds: string[]) => Promise<unknown[]>;
  toggleFavoriteVenue: (
    venueId: string,
    favorite: boolean | undefined,
  ) => Promise<FavoriteVenueResult>;
};

type FavoriteVenueRouteDependencies = {
  createDataClient: () => Promise<FavoriteVenueDataClient>;
  requireAccess: RequireUserApiAccess;
};

function getVenueId(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("venueId" in body)) {
    return null;
  }

  const { venueId } = body as FavoriteVenueRequestBody;
  return typeof venueId === "string" && venueId.length > 0 ? venueId : null;
}

function getFavorite(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object" || !("favorite" in body)) {
    return undefined;
  }

  const { favorite } = body as FavoriteVenueRequestBody;
  return typeof favorite === "boolean" ? favorite : undefined;
}

async function readRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return badUserApiRequest("Invalid JSON body.");
  }
}

export function createFavoriteVenueRouteHandlers({
  createDataClient,
  requireAccess,
}: FavoriteVenueRouteDependencies) {
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
        const venueId = getVenueId(body);
        if (!venueId) {
          return badUserApiRequest("A valid venueId is required.");
        }
        const favorite = getFavorite(body);

        const client = await callUserApiDependency(createDataClient);
        const result = await callUserApiDependency(
          () => client.toggleFavoriteVenue(venueId, favorite),
          {
            notFoundErrorIncludes: "Venue not found.",
            notFoundMessage: "Venue not found.",
          },
        );
        const venues = result.favorite
          ? await callUserApiDependency(() => client.getVenues([venueId]))
          : [];
        const venue = venues[0] ?? null;

        return { ...result, userId, venue, venueId };
      }),
  };
}
