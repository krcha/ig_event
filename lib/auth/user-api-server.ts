import "server-only";

import { auth } from "@clerk/nextjs/server";
import {
  preflightUserApiAccess,
  type RequireUserApiAccess,
} from "@/lib/auth/user-api";
import { hasClerkEnv } from "@/lib/utils/env";

export const requireUserApiAccess: RequireUserApiAccess = async () =>
  preflightUserApiAccess({
    authConfigured: hasClerkEnv(),
    getUserId: async () => (await auth()).userId,
  });
