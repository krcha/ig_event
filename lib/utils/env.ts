export function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export function hasClerkEnv(): boolean {
  return Boolean(
    hasEnvValue("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") &&
      hasEnvValue("CLERK_SECRET_KEY"),
  );
}

export function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  );
}

export function shouldFailClosedForAdminRoutes(): boolean {
  return isProductionRuntime() && !hasClerkEnv();
}

export function getOpenAiModelEnv(name: "OPENAI_REVIEW_MODEL" | "OPENAI_VISION_MODEL"): string {
  const configured = process.env[name]?.trim();
  if (configured) {
    return configured;
  }

  if (isProductionRuntime()) {
    throw new Error(`Missing required production environment variable: ${name}`);
  }

  return "gpt-4.1-mini";
}
