import type { UserIdentity } from "convex/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";

type AuthzCtx = Pick<QueryCtx | MutationCtx | ActionCtx, "auth">;

const ADMIN_USER_ID_SEPARATOR = /[\s,]+/;

function getConfiguredAdminClerkUserIds(): Set<string> {
  return new Set(
    (process.env.ADMIN_CLERK_USER_IDS ?? "")
      .split(ADMIN_USER_ID_SEPARATOR)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function isAdminSubject(subject: string | null | undefined): boolean {
  return Boolean(subject && getConfiguredAdminClerkUserIds().has(subject));
}

function hasMatchingServiceSecret(serviceSecret: string | undefined): boolean {
  const configuredSecret = process.env.CRON_SECRET?.trim();
  return Boolean(configuredSecret && serviceSecret && serviceSecret === configuredSecret);
}

export async function requireViewerIdentity(ctx: AuthzCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Authentication required.");
  }
  return identity;
}

export async function requireAdminIdentity(ctx: AuthzCtx): Promise<UserIdentity> {
  const identity = await requireViewerIdentity(ctx);
  if (!isAdminSubject(identity.subject)) {
    throw new Error("Admin access required.");
  }
  return identity;
}

export async function requireAdminOrServiceSecret(
  ctx: AuthzCtx,
  serviceSecret: string | undefined,
): Promise<{ actor: string; kind: "admin" | "service" }> {
  if (hasMatchingServiceSecret(serviceSecret)) {
    return { actor: "service:cron", kind: "service" };
  }

  const identity = await requireAdminIdentity(ctx);
  return { actor: identity.subject, kind: "admin" };
}
