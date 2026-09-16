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

  let token: string | null = null;
  let expiresAt = 0;
  let refreshing: Promise<string> | undefined;
  async function currentToken(): Promise<string> {
    if (token && expiresAt > Date.now() + 10_000) return token;
    if (!refreshing) {
      refreshing = (async () => {
        const nextToken = await getToken({ template: "convex" });
        if (!nextToken) throw new Error("Could not create Convex auth token.");
        let nextExpiresAt = 0;
        try {
          // This claim only schedules renewal; Convex still verifies the JWT.
          const claims = JSON.parse(
            Buffer.from(nextToken.split(".")[1], "base64url").toString("utf8"),
          );
          if (typeof claims.exp === "number") nextExpiresAt = claims.exp * 1_000;
        } catch {
          // Never include token contents in an error.
        }
        if (!Number.isFinite(nextExpiresAt) || nextExpiresAt <= Date.now() + 10_000) {
          throw new Error("Could not create a fresh Convex auth token.");
        }
        token = nextToken;
        expiresAt = nextExpiresAt;
        return nextToken;
      })().finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  }

  return new ConvexHttpClient(getRequiredEnv("NEXT_PUBLIC_CONVEX_URL"), {
    auth: await currentToken(),
    fetch: async (input, init) => {
      // Run at transport time, including after a mutation waits in the SDK queue.
      const authToken = await currentToken();
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${authToken}`);
      return fetch(input, { ...init, headers });
    },
  });
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
