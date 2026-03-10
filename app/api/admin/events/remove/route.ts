import { auth } from "@clerk/nextjs/server";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NextResponse } from "next/server";
import { hasClerkEnv } from "@/lib/utils/env";

type RequestBody = {
  eventId?: string;
};

const deleteApprovedEventMutation =
  "events:deleteApprovedEvent" as unknown as FunctionReference<"mutation">;

function getConvexHttpClient() {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  }
  return new ConvexHttpClient(convexUrl);
}

export async function POST(request: Request) {
  if (hasClerkEnv()) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventId = body.eventId?.trim() || "";
  if (!eventId) {
    return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  }

  try {
    const convex = getConvexHttpClient();
    await convex.mutation(deleteApprovedEventMutation, {
      id: eventId,
    });

    return NextResponse.json({
      ok: true,
      eventId,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to remove approved event.",
      },
      { status: 500 },
    );
  }
}
