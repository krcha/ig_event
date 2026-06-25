import "server-only";

import { hasClerkEnv, isProductionRuntime } from "@/lib/utils/env";

type ReadinessCheck = {
  name: string;
  ok: boolean;
  required: boolean;
};

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function checkEnv(name: string, required: boolean): ReadinessCheck {
  return {
    name,
    ok: hasEnv(name),
    required,
  };
}

export function getReadinessStatus() {
  const production = isProductionRuntime();
  const checks: ReadinessCheck[] = [
    checkEnv("NEXT_PUBLIC_CONVEX_URL", true),
    checkEnv("CRON_SECRET", true),
    checkEnv("CLERK_JWT_ISSUER_DOMAIN", true),
    checkEnv("ADMIN_CLERK_USER_IDS", true),
    checkEnv("OPENAI_API_KEY", true),
    checkEnv("OPENAI_VISION_MODEL", production),
    checkEnv("OPENAI_REVIEW_MODEL", production),
    checkEnv("APIFY_API_TOKEN", false),
  ];

  checks.push({
    name: "CLERK_NEXT_ENV",
    ok: hasClerkEnv(),
    required: true,
  });

  const missingRequired = checks
    .filter((check) => check.required && !check.ok)
    .map((check) => check.name);

  return {
    ok: missingRequired.length === 0,
    service: "ig-event",
    production,
    missingRequired,
    checks,
    timestamp: new Date().toISOString(),
  };
}
