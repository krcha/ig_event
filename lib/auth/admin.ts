import "server-only";

import { auth } from "@clerk/nextjs/server";
import { hasClerkEnv } from "@/lib/utils/env";

const ADMIN_USER_ID_SEPARATOR = /[\s,]+/;

function getConfiguredAdminClerkUserIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_CLERK_USER_IDS ?? "")
      .split(ADMIN_USER_ID_SEPARATOR)
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function isAdminClerkUserId(userId: string | null | undefined): boolean {
  if (!userId) {
    return false;
  }

  return getConfiguredAdminClerkUserIds().has(userId);
}

export async function isViewerAdmin(): Promise<boolean> {
  if (!hasClerkEnv()) {
    return false;
  }

  const adminUserIds = getConfiguredAdminClerkUserIds();
  if (adminUserIds.size === 0) {
    return false;
  }

  const { userId } = await auth();
  return adminUserIds.has(userId ?? "");
}
