import {
  callUserApiDependency,
  runUserApiHandler,
  type RequireUserApiAccess,
} from "@/lib/auth/user-api";

type LibraryDataClient = {
  getLibrary: () => Promise<unknown>;
};

type LibraryRouteDependencies = {
  createDataClient: () => Promise<LibraryDataClient>;
  requireAccess: RequireUserApiAccess;
};

export function createLibraryRouteHandlers({
  createDataClient,
  requireAccess,
}: LibraryRouteDependencies) {
  return {
    GET: () =>
      runUserApiHandler(requireAccess, async () => {
        const client = await callUserApiDependency(createDataClient);
        return callUserApiDependency(client.getLibrary);
      }),
  };
}
