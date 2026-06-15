"use client";

import { useClerk, useAuth } from "@clerk/nextjs";
import { useCallback } from "react";

type RunAuthenticatedActionOptions = {
  action: () => void | Promise<void>;
};

export function useRequireAuth() {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, userId } = useAuth();

  const requireAuth = useCallback(
    () => {
      if (!isLoaded) {
        return false;
      }

      if (isSignedIn) {
        return true;
      }

      void clerk.openSignIn();
      return false;
    },
    [clerk, isLoaded, isSignedIn],
  );

  const runAuthenticatedAction = useCallback(
    async ({ action }: RunAuthenticatedActionOptions) => {
      if (!requireAuth()) {
        return false;
      }

      await action();
      return true;
    },
    [requireAuth],
  );

  return {
    isLoaded,
    isSignedIn: isSignedIn === true,
    requireAuth,
    runAuthenticatedAction,
    userId: userId ?? null,
  };
}
