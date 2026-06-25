"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";

type RunAuthenticatedActionOptions = {
  action: () => void | Promise<void>;
};

export function useRequireAuth() {
  const { isLoaded, isSignedIn, userId } = useAuth();

  const redirectToSignIn = useCallback(() => {
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/sign-in?redirect_url=${encodeURIComponent(currentPath)}`);
  }, []);

  const requireAuth = useCallback(
    () => {
      if (!isLoaded) {
        redirectToSignIn();
        return false;
      }

      if (isSignedIn) {
        return true;
      }

      redirectToSignIn();
      return false;
    },
    [isLoaded, isSignedIn, redirectToSignIn],
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
