import type { FunctionReference } from "convex/server";
import { createLibraryRouteHandlers } from "@/app/api/user/library/handler";
import { requireUserApiAccess } from "@/lib/auth/user-api-server";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;

export const { GET } = createLibraryRouteHandlers({
  createDataClient: async () => {
    const convex = await createAuthenticatedConvexHttpClient();
    return {
      getLibrary: () => convex.query(getMyLibraryQuery, {}),
    };
  },
  requireAccess: requireUserApiAccess,
});
