import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { normalizeInstagramMediaSourceIdentity } from "../lib/images/media-source-identity.ts";
import { assertAllowedRemoteImageUrl } from "../lib/images/remote-image-policy.ts";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LIMIT = 500;
const MAX_CONCURRENCY = 8;
const MAX_LIMIT = 500;

export function usage() {
  return [
    "Usage: npm run repair:durable-instagram-images -- --manifest PATH [--apply] [--limit N] [--concurrency N]",
    "",
    "Dry-run is the default. The manifest must be a JSON array of source records:",
    '  [{"postId":"...","instagramPostUrl":"https://www.instagram.com/p/.../","upstreamUrl":"https://..."}]',
    "",
    `Bounds: --limit 1-${MAX_LIMIT}; --concurrency 1-${MAX_CONCURRENCY}.`,
    "The script never calls Apify. --apply invokes the authenticated Convex storage action.",
  ].join("\n");
}

function readBoundedInteger(name, rawValue, maximum) {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${name} value: ${rawValue}. Expected 1-${maximum}.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
    limit: DEFAULT_LIMIT,
    manifestPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--manifest") {
      options.manifestPath = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      options.limit = readBoundedInteger("--limit", argv[index + 1], MAX_LIMIT);
      index += 1;
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = readBoundedInteger(
        "--concurrency",
        argv[index + 1],
        MAX_CONCURRENCY,
      );
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.help && !options.manifestPath) {
    throw new Error("--manifest PATH is required.");
  }
  return options;
}

function readOptionalString(row, field) {
  const value = row[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Manifest field ${field} must be a non-empty string when provided.`);
  }
  return value.trim();
}

export function parseManifestText(text, limit = DEFAULT_LIMIT) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(value)) {
    throw new Error("Manifest root must be a JSON array.");
  }
  if (value.length > limit) {
    throw new Error(`Manifest has ${value.length} rows, exceeding the configured limit of ${limit}.`);
  }

  const seenSourceKeys = new Set();
  return value.map((rawRow, index) => {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      throw new Error(`Manifest row ${index + 1} must be an object.`);
    }
    const postId =
      readOptionalString(rawRow, "postId") ?? readOptionalString(rawRow, "instagramPostId");
    const instagramPostUrl = readOptionalString(rawRow, "instagramPostUrl");
    const upstreamUrl =
      readOptionalString(rawRow, "upstreamUrl") ??
      readOptionalString(rawRow, "sourceImageUrl");
    if (!upstreamUrl) {
      throw new Error(`Manifest row ${index + 1} is missing upstreamUrl.`);
    }
    assertAllowedRemoteImageUrl(upstreamUrl);
    const identity = normalizeInstagramMediaSourceIdentity({ postId, instagramPostUrl });
    if (seenSourceKeys.has(identity.sourceKey)) {
      throw new Error(`Manifest row ${index + 1} duplicates source ${identity.sourceKey}.`);
    }
    seenSourceKeys.add(identity.sourceKey);
    return {
      ...(identity.postId ? { postId: identity.postId } : {}),
      ...(identity.normalizedInstagramPostUrl
        ? { instagramPostUrl: identity.normalizedInstagramPostUrl }
        : {}),
      upstreamUrl,
      sourceKey: identity.sourceKey,
    };
  });
}

export function loadEnvFiles() {
  for (const envFile of [".env.local", ".env"]) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}

export async function runRepair(options) {
  const rows = options.rows;
  if (!options.apply) {
    return {
      applied: false,
      failed: 0,
      processed: rows.length,
      results: rows.map((row) => ({ sourceKey: row.sourceKey, status: "dry-run" })),
    };
  }
  if (!options.client) {
    throw new Error("A Convex client is required in apply mode.");
  }
  if (!options.serviceSecret) {
    throw new Error("CRON_SECRET is required in apply mode.");
  }

  const results = new Array(rows.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const result = await options.client.action(api.mediaActions.persistInstagramImage, {
          ...(row.postId ? { postId: row.postId } : {}),
          ...(row.instagramPostUrl ? { instagramPostUrl: row.instagramPostUrl } : {}),
          upstreamUrl: row.upstreamUrl,
          serviceSecret: options.serviceSecret,
        });
        results[index] = {
          sourceKey: row.sourceKey,
          status: "applied",
          attachedEventCount: result.attachedEventCount,
          attachedScrapedPostCount: result.attachedScrapedPostCount,
          reused: result.reused,
          checksumSha256: result.checksumSha256,
        };
      } catch (error) {
        results[index] = {
          sourceKey: row.sourceKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker()),
  );
  const failed = results.filter((result) => result.status === "failed").length;
  return { applied: true, failed, processed: rows.length, results };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const rows = parseManifestText(readFileSync(resolve(options.manifestPath), "utf8"), options.limit);
  loadEnvFiles();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceSecret = process.env.CRON_SECRET;
  const result = await runRepair({
    apply: options.apply,
    client: options.apply && convexUrl ? new ConvexHttpClient(convexUrl) : null,
    concurrency: options.concurrency,
    rows,
    serviceSecret,
  });

  for (const item of result.results) {
    console.log(JSON.stringify(item));
  }
  console.log(
    JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      processed: result.processed,
      failed: result.failed,
    }),
  );
  if (options.apply && !convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required in apply mode.");
  }
  if (result.failed > 0) {
    throw new Error(`${result.failed} durable image repair item(s) failed.`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
