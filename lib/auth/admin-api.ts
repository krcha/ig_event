import "server-only";

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  hasConfiguredAdminClerkUserIds,
  isAdminClerkUserId,
} from "@/lib/auth/admin";
import { hasClerkEnv, shouldFailClosedForAdminRoutes } from "@/lib/utils/env";

export type AdminApiAccessResult =
  | {
      ok: true;
      userId: string | null;
    }
  | {
      ok: false;
      response: NextResponse;
    };

export async function requireAdminApiAccess(): Promise<AdminApiAccessResult> {
  if (!hasClerkEnv()) {
    if (shouldFailClosedForAdminRoutes()) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Admin authentication is not configured." },
          { status: 503 },
        ),
      };
    }

    return {
      ok: true,
      userId: null,
    };
  }

  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!hasConfiguredAdminClerkUserIds()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Admin allowlist is not configured." },
        { status: 503 },
      ),
    };
  }

  if (!isAdminClerkUserId(userId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return {
    ok: true,
    userId,
  };
}
