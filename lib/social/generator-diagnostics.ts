type GeneratorDiagnosticContext = {
  format: "carousel" | "story" | "reel";
  publishDate: string;
  stage: "query" | "payload/layout";
  page: number | null;
  startedAt: number;
};

const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|ENCRYPTION|AUTH|COOKIE|SESSION|(?:^|_)KEY(?:_|$)/i;

function redactDiagnostic(value: string, limit: number): string {
  let safe = value;
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => SECRET_ENV_NAME.test(name) && Boolean(secret))
    .map(([, secret]) => secret as string)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]/g, " ").slice(0, limit);
}

export function logGeneratorFailure(error: unknown, context: GeneratorDiagnosticContext): void {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Non-Error generator failure.";
  console.error("[social-generator-failure]", {
    format: context.format,
    date: context.publishDate,
    stage: context.stage,
    page: context.page,
    elapsedMs: Math.max(0, Date.now() - context.startedAt),
    errorName: redactDiagnostic(name, 64),
    message: redactDiagnostic(message, 384),
  });
}
