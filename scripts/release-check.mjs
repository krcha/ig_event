import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 120_000;

const checks = [
  { script: "lint", timeoutMs: 120_000 },
  { script: "typecheck", timeoutMs: 180_000 },
  { script: "build", timeoutMs: 900_000 },
  { script: "qa:dedupe", timeoutMs: 60_000 },
  { script: "qa:automerge", timeoutMs: 60_000 },
  { script: "qa:master-review", timeoutMs: 60_000 },
  { script: "qa:extraction", timeoutMs: 60_000 },
  { script: "qa:moderation-queue", timeoutMs: 60_000 },
  { script: "qa:ingestion-triage", timeoutMs: 60_000 },
  { script: "qa:venue-types", timeoutMs: 60_000 },
  { script: "qa:venue-hours", timeoutMs: 60_000 },
  { script: "qa:google-hours", timeoutMs: 60_000 },
  { script: "qa:public-search", timeoutMs: 60_000 },
  { script: "qa:public-sort", timeoutMs: 60_000 },
  { script: "qa:public-performance", timeoutMs: 60_000 },
  { script: "qa:mobile-calendar", timeoutMs: 60_000 },
  { script: "qa:app-toolbar", timeoutMs: 60_000 },
  { script: "qa:discover-feed", timeoutMs: 60_000 },
  { script: "qa:apify", timeoutMs: 60_000 },
  { script: "qa:follow-discovery", timeoutMs: 60_000 },
  { script: "qa:convex-auth-boundaries", timeoutMs: 60_000 },
  { script: "qa:ingestion-leases", timeoutMs: 60_000 },
  { script: "qa:public-event-windows", timeoutMs: 60_000 },
  { script: "qa:image-guardrails", timeoutMs: 60_000 },
  { script: "qa:runtime-config", timeoutMs: 60_000 },
  { script: "qa:convex-retention-cron", timeoutMs: 60_000 },
  { script: "qa:clerk-email-auth", timeoutMs: 60_000 },
  { script: "qa:user-api-auth", timeoutMs: 60_000 },
  { script: "qa:admin-auth", timeoutMs: 60_000 },
];

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function readTimeoutMs(defaultTimeoutMs) {
  const rawTimeout = process.env.RELEASE_CHECK_TIMEOUT_MS;
  if (!rawTimeout) {
    return defaultTimeoutMs;
  }

  const parsedTimeout = Number.parseInt(rawTimeout, 10);
  if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
    return parsedTimeout;
  }

  console.warn(
    `Ignoring invalid RELEASE_CHECK_TIMEOUT_MS=${JSON.stringify(rawTimeout)}.`,
  );
  return defaultTimeoutMs;
}

function formatDuration(ms) {
  return `${Math.round(ms / 1000)}s`;
}

function runNpmScript(script, timeoutMs) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    let timedOut = false;
    let hardKillTimer = null;

    const child = spawn(npmCommand, ["run", script], {
      detached: process.platform !== "win32",
      env: process.env,
      stdio: "inherit",
    });

    function killChild(signal) {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing the npm process directly below.
        }
      }

      child.kill(signal);
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(
        `\n[timeout] npm run ${script} exceeded ${formatDuration(timeoutMs)}.`,
      );
      killChild("SIGTERM");

      hardKillTimer = setTimeout(() => {
        killChild("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }

      resolve({
        elapsedMs: Date.now() - startMs,
        error,
        script,
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
      }

      resolve({
        code,
        elapsedMs: Date.now() - startMs,
        script,
        signal,
        timedOut,
      });
    });
  });
}

const failures = [];

console.log("Running release gates:");
for (const check of checks) {
  const timeoutMs = readTimeoutMs(check.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  console.log(`\n[run] npm run ${check.script} (timeout ${formatDuration(timeoutMs)})`);

  const result = await runNpmScript(check.script, timeoutMs);
  const elapsed = formatDuration(result.elapsedMs);

  if (result.error) {
    failures.push(`${check.script}: ${result.error.message}`);
    console.error(`[fail] ${check.script} could not start after ${elapsed}.`);
    continue;
  }

  if (result.timedOut) {
    failures.push(`${check.script}: timed out after ${formatDuration(timeoutMs)}`);
    console.error(`[fail] ${check.script} timed out after ${elapsed}.`);
    continue;
  }

  if (result.code !== 0) {
    const detail = result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.code}`;
    failures.push(`${check.script}: ${detail}`);
    console.error(`[fail] ${check.script} failed with ${detail} after ${elapsed}.`);
    continue;
  }

  console.log(`[pass] ${check.script} passed in ${elapsed}.`);
}

if (failures.length > 0) {
  console.error("\nRelease gates failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("\nRelease gates passed.");
