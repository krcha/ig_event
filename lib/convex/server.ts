import "server-only";

import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { getRequiredEnv } from "@/lib/utils/env";

export function createConvexHttpClient(authToken?: string): ConvexHttpClient {
  const options = authToken ? { auth: authToken } : undefined;
  return new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"), options);
}

export async function createAuthenticatedConvexHttpClient(): Promise<ConvexHttpClient> {
  const { getToken, userId } = await auth();
  if (!userId) {
    throw new Error("Authentication required.");
  }

  const token = await getToken({ template: "convex" });
  if (!token) {
    throw new Error("Could not create Convex auth token.");
  }

  return createConvexHttpClient(token);
}

export function getServiceSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}

export function requireServiceSecret(): string {
  const serviceSecret = getServiceSecret();
  if (!serviceSecret) {
    throw new Error("CRON_SECRET is not configured.");
  }
  return serviceSecret;
}
