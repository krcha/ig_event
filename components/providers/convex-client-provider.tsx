"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useAuth } from "@clerk/nextjs";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

let hasWarnedAboutConvex = false;
let hasWarnedAboutClerk = false;

export function ConvexClientProvider({
  children,
}: {
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

  if (!clerkPublishableKey) {
    if (!hasWarnedAboutClerk && typeof window !== "undefined") {
      console.warn(
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. Rendering Convex without Clerk auth integration.",
      );
      hasWarnedAboutClerk = true;
    }

    return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
  }

  return (
    <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
