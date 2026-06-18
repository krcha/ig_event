import { auth, currentUser } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { hasClerkEnv } from "@/lib/utils/env";

async function ensureConvexUser(convex: ConvexHttpClient, clerkUserId: string) {
  const clerkUser = await currentUser();
  await convex.mutation(api.users.upsertUser, {
    clerkId: clerkUserId,
    email: clerkUser?.primaryEmailAddress?.emailAddress,
  });
}

export async function GET() {
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Sign in to view saved events and favorite venues." }, { status: 401 });
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return NextResponse.json({ error: "Convex is not configured." }, { status: 503 });
  }

  try {
    const convex = new ConvexHttpClient(convexUrl);
    await ensureConvexUser(convex, userId);
    const result = await convex.query(api.users.listLibrary, { userId });
    return NextResponse.json({ ...result, userId });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not load saved events and favorite venues.",
      },
      { status: 500 },
    );
  }
}
