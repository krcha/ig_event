import "server-only";

import { hasClerkEnv, isProductionRuntime } from "@/lib/utils/env";
import { getInstagramScraperProvider } from "@/lib/scraper/instaloader-client";

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
    checkEnv("CLERK_AUTHORIZED_PARTIES", production),
    checkEnv("ADMIN_CLERK_USER_IDS", true),
    checkEnv("OPENAI_API_KEY", true),
    checkEnv("OPENAI_VISION_MODEL", production),
    checkEnv("OPENAI_REVIEW_MODEL", production),
    checkEnv("APIFY_API_TOKEN", false),
  ];

  // Configuration readiness is separate from the collector's live Instagram login.
  try {
    if (getInstagramScraperProvider() === "instaloader") {
      checks.push(checkEnv("INSTALOADER_API_URL", true), checkEnv("INSTALOADER_API_TOKEN", true));
    }
  } catch {
    checks.push({ name: "INSTAGRAM_SCRAPER_PROVIDER", ok: false, required: true });
  }

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
