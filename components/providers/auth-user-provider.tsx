"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { createContext, useContext, useMemo } from "react";

type AuthUserContextValue = {
  clerkUserId: string | null;
  email: string | null;
  imageUrl: string | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  name: string | null;
};

const defaultAuthUserContext: AuthUserContextValue = {
  clerkUserId: null,
  email: null,
  imageUrl: null,
  isLoaded: false,
  isSignedIn: false,
  name: null,
};

const AuthUserContext = createContext<AuthUserContextValue>(defaultAuthUserContext);

export function AuthUserProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { isLoaded: isUserLoaded, user } = useUser();

  const value = useMemo<AuthUserContextValue>(() => {
    const email = user?.primaryEmailAddress?.emailAddress ?? null;
    const name = user?.fullName ?? user?.username ?? email ?? null;

    return {
      clerkUserId: userId ?? null,
      email,
      imageUrl: user?.imageUrl ?? null,
      isLoaded: isAuthLoaded && isUserLoaded,
      isSignedIn: isSignedIn === true,
      name,
    };
  }, [isAuthLoaded, isSignedIn, isUserLoaded, user, userId]);

  return <AuthUserContext.Provider value={value}>{children}</AuthUserContext.Provider>;
}

export function useAuthUser() {
  return useContext(AuthUserContext);
}
