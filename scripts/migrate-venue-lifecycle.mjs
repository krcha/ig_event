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

function addCounts(total, page) {
  for (const [key, value] of Object.entries(page)) {
    total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

async function loadCompletePreview(client, serviceSecret) {
  let cursor = null;
  const counts = {};
  const rollbackManifest = [];
  const sampleChanges = [];
  let rollbackMapping = null;
  do {
    const page = await client.query(api.venues.previewVenueLifecycleMigration, {
      paginationOpts: { cursor, numItems: 100 },
      serviceSecret,
    });
    addCounts(counts, page.counts);
    rollbackManifest.push(...page.rollbackManifest);
    if (sampleChanges.length < 20) {
      sampleChanges.push(
        ...JSON.parse(page.sampleChangesJson).slice(0, 20 - sampleChanges.length),
      );
    }
    rollbackMapping ??= page.rollbackMapping;
    cursor = page.continueCursor;
    if (page.isDone) break;
  } while (true);
  return { counts, rollbackManifest, rollbackMapping, sampleChanges };
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
  const preview = await loadCompletePreview(client, serviceSecret);
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

  let appliedTotal = 0;
  for (
    let offset = 0;
    offset < reviewedRollbackManifest.length;
    offset += options.limit
  ) {
    const rollbackManifest = reviewedRollbackManifest.slice(
      offset,
      offset + options.limit,
    );
    const result = await client.mutation(api.venues.applyVenueLifecycleMigrationBatch, {
      backupReference: options.backupReference,
      rollbackManifest,
      serviceSecret,
    });
    appliedTotal += result.applied;
    console.log(JSON.stringify({ appliedTotal, ...result }, null, 2));
    if (result.applied !== rollbackManifest.length) {
      throw new Error("Migration did not apply the complete reviewed batch; stop and inspect.");
    }
  }

  const finalPreview = await loadCompletePreview(client, serviceSecret);
  console.log(JSON.stringify({ appliedTotal, dryRun: false, final: finalPreview }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
