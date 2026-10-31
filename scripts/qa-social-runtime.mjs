import { spawnSync } from "node:child_process";

// Exercise the production renderer and publishing state machine without posting.
for (const name of [
  "generator-diagnostics", "generator-retries", "carousel-jpeg-cache",
  "social-special-20261025", "social-variety", "raw-agenda-stream",
  "n8n-daily-stories", "n8n-daily-reels",
  "daily-stories", "daily-reels",
]) {
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/register-ts-paths.mjs",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types",
    `scripts/qa-${name}.mjs`,
  ], { stdio: "inherit", timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
