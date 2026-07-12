import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONFIRMATION = "APPLY_VENUE_LIFECYCLE";

function usage() {
  return [
    "Usage: npm run migrate:venue-lifecycle -- [--rollback-manifest PATH] [--apply --confirm APPLY_VENUE_LIFECYCLE --backup-reference REF] [--limit N]",
    "",
    "Dry-run is the default. It reports migration counts and the complete exact rollbackManifest without writing data.",
    "Use --rollback-manifest PATH to export the complete per-record rollback manifest as JSON.",
    "Apply mode requires the reviewed rollback-manifest file, a verified Convex backup reference, and an explicit confirmation token.",
  ].join("\n");
}

function readPositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`${label} must be an integer from 1 to 100.`);
  }
  return parsed;
}

function parseArgs(argv) {
  let apply = false;
  let backupReference = "";
  let confirm = "";
  let limit = 50;
  let rollbackManifestPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--backup-reference") {
      backupReference = argv[++index]?.trim() ?? "";
      continue;
    }
    if (arg === "--confirm") {
      confirm = argv[++index]?.trim() ?? "";
      continue;
    }
    if (arg === "--limit") {
      limit = readPositiveInteger(argv[++index], "--limit");
      continue;
    }
    if (arg === "--rollback-manifest") {
      rollbackManifestPath = argv[++index]?.trim() ?? "";
      if (!rollbackManifestPath) {
        throw new Error("--rollback-manifest requires a path.");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const dryRun = !apply;
  return { apply, backupReference, confirm, dryRun, limit, rollbackManifestPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  const serviceSecret = process.env.CRON_SECRET?.trim();
  if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  if (!serviceSecret) throw new Error("CRON_SECRET is required.");

  if (options.apply) {
    if (options.confirm !== CONFIRMATION) {
      throw new Error(`Apply mode requires --confirm ${CONFIRMATION}.`);
    }
    if (!options.backupReference) {
      throw new Error("Apply mode requires --backup-reference REF.");
    }
    if (!options.rollbackManifestPath) {
      throw new Error("Apply mode requires --rollback-manifest PATH from the reviewed dry-run.");
    }
  }

  let reviewedRollbackManifest = null;
  if (options.apply) {
    try {
      reviewedRollbackManifest = JSON.parse(
        readFileSync(options.rollbackManifestPath, "utf8"),
      );
    } catch (error) {
      throw new Error(
        `Failed to read reviewed rollback manifest: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!Array.isArray(reviewedRollbackManifest)) {
      throw new Error("Reviewed rollback manifest must be a JSON array.");
    }
  }

  const client = new ConvexHttpClient(convexUrl);
  const preview = await client.query(api.venues.previewVenueLifecycleMigration, {
    serviceSecret,
  });
  console.log(JSON.stringify({ dryRun: options.dryRun, ...preview }, null, 2));
  if (options.rollbackManifestPath && options.dryRun) {
    writeFileSync(
      options.rollbackManifestPath,
      `${JSON.stringify(preview.rollbackManifest, null, 2)}\n`,
      "utf8",
    );
    console.error(`Wrote ${preview.rollbackManifest.length} rollback records to ${options.rollbackManifestPath}.`);
  }

  if (options.dryRun) return;

  if (JSON.stringify(reviewedRollbackManifest) !== JSON.stringify(preview.rollbackManifest)) {
    throw new Error(
      "Current lifecycle state does not match the reviewed rollback manifest; export and review a fresh manifest.",
    );
  }
  if (preview.counts.needsMigration === 0) return;

  let remaining = preview.counts.needsMigration;
  let appliedTotal = 0;
  let remainingRollbackManifest = reviewedRollbackManifest;
  while (remaining > 0) {
    const result = await client.mutation(api.venues.applyVenueLifecycleMigrationBatch, {
      backupReference: options.backupReference,
      expectedRollbackManifestJson: JSON.stringify(remainingRollbackManifest),
      limit: options.limit,
      serviceSecret,
    });
    appliedTotal += result.applied;
    remaining = result.remaining;
    const appliedIds = new Set(result.appliedIds);
    remainingRollbackManifest = remainingRollbackManifest.filter(
      (record) => !appliedIds.has(record.id),
    );
    console.log(JSON.stringify({ appliedTotal, ...result }, null, 2));
    if (result.applied === 0 && remaining > 0) {
      throw new Error("Migration made no progress; stop and inspect before retrying.");
    }
  }

  const finalPreview = await client.query(api.venues.previewVenueLifecycleMigration, {
    serviceSecret,
  });
  console.log(JSON.stringify({ appliedTotal, dryRun: false, final: finalPreview }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
