"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;

let hasWarnedAboutConvex = false;

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

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
