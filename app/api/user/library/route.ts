import { NextResponse } from "next/server";
import type { FunctionReference } from "convex/server";
import { createAuthenticatedConvexHttpClient } from "@/lib/convex/server";
import { hasClerkEnv } from "@/lib/utils/env";

const getMyLibraryQuery = "users:getMyLibrary" as unknown as FunctionReference<"query">;

export async function GET() {
  if (!hasClerkEnv()) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  try {
    const convex = await createAuthenticatedConvexHttpClient();
    const result = await convex.query(getMyLibraryQuery, {});
    return NextResponse.json(result);
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
