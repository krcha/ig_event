"use client";

import { useAuth } from "@clerk/nextjs";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;

let hasWarnedAboutConvex = false;

export function ConvexClientProvider({
  authEnabled = false,
  children,
}: {
  authEnabled?: boolean;
  children: React.ReactNode;
}) {
  if (!convexClient) {
    if (!hasWarnedAboutConvex && typeof window !== "undefined") {
      console.warn(
        "NEXT_PUBLIC_CONVEX_URL is not set. Rendering without Convex provider.",
      );
      hasWarnedAboutConvex = true;
    }
    return <>{children}</>;
  }

  if (authEnabled) {
    return (
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    );
  }

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
