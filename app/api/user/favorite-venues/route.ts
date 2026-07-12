import type { FunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { createFavoriteVenueRouteHandlers } from "@/app/api/user/favorite-venues/handler";
import { requireUserApiAccess } from "@/lib/auth/user-api-server";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;
const toggleMyFavoriteVenueMutation =
  "users:toggleMyFavoriteVenue" as unknown as FunctionReference<"mutation">;
const listPublicVenueFieldsByIdsQuery =
  "venues:listPublicVenueFieldsByIds" as unknown as FunctionReference<"query">;

export const { GET, POST } = createFavoriteVenueRouteHandlers({
  createDataClient: async () => {
    const convex = await createAuthenticatedConvexHttpClient();
    return {
      getLibrary: () => convex.query(getMyLibraryQuery, {}),
      getVenues: (venueIds: string[]) =>
        convex.query(listPublicVenueFieldsByIdsQuery, {
          ids: venueIds as Id<"venues">[],
        }) as Promise<unknown[]>,
      toggleFavoriteVenue: (venueId: string, favorite: boolean | undefined) =>
        convex.mutation(toggleMyFavoriteVenueMutation, {
          favorite,
          venueId: venueId as Id<"venues">,
        }),
    };
  },
  requireAccess: requireUserApiAccess,
});
