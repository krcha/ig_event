import type { FunctionReference } from "convex/server";
import type { Id } from "@/convex/_generated/dataModel";
import { createSavedEventRouteHandlers } from "@/app/api/user/saved-events/handler";
import { requireUserApiAccess } from "@/lib/auth/user-api-server";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;
const toggleMySavedEventMutation =
  "users:toggleMySavedEvent" as unknown as FunctionReference<"mutation">;
const getPublicApprovedEventQuery =
  "events:getPublicApprovedEvent" as unknown as FunctionReference<"query">;

export const { GET, POST } = createSavedEventRouteHandlers({
  createDataClient: async () => {
    const convex = await createAuthenticatedConvexHttpClient();
    return {
      getEvent: (eventId: string) =>
        convex.query(getPublicApprovedEventQuery, {
          id: eventId as Id<"events">,
        }),
      getLibrary: () => convex.query(getMyLibraryQuery, {}),
      toggleSavedEvent: (eventId: string, saved: boolean | undefined) =>
        convex.mutation(toggleMySavedEventMutation, {
          eventId: eventId as Id<"events">,
          saved,
        }),
    };
  },
  requireAccess: requireUserApiAccess,
});
