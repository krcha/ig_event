"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";
import { useLocale } from "@/i18n/client";
import { localizeHref } from "@/i18n/config";

type RunAuthenticatedActionOptions = {
  action: () => void | Promise<void>;
};

export function useRequireAuth() {
  const locale = useLocale();
  const { isLoaded, isSignedIn, userId } = useAuth();

  const redirectToSignIn = useCallback(() => {
    const currentPath =
      typeof window === "undefined"
        ? "/"
        : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`${localizeHref("/sign-in", locale)}?redirect_url=${encodeURIComponent(currentPath)}`);
  }, [locale]);

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
