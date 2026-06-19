import { existsSync, readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const DEFAULT_LIMIT = 1000;
const DEFAULT_STATUSES = ["approved", "pending"];

function usage() {
  return [
    "Usage: npm run repair:event-apify-images -- [--apply] [--limit N] [--status approved,pending]",
    "",
    "Dry-run is the default. Patches event imageUrl values from matching scrapedPosts",
    "when the scraped post has an images.apifyusercontent.com image candidate.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    apply: false,
    limit: DEFAULT_LIMIT,
    statuses: DEFAULT_STATUSES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[index + 1];
      index += 1;
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit value: ${next}`);
      }
      options.limit = Math.trunc(parsed);
      continue;
    }
    if (arg === "--status") {
      const next = argv[index + 1];
      index += 1;
      const statuses = (next ?? "")
        .split(",")
        .map((status) => status.trim())
        .filter(Boolean);
      const invalid = statuses.filter(
        (status) => !["approved", "pending", "rejected"].includes(status),
      );
      if (statuses.length === 0 || invalid.length > 0) {
        throw new Error(`Invalid --status value: ${next}`);
      }
      options.statuses = statuses;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function loadEnvFiles() {
  for (const envFile of [".env.local", ".env"]) {
    if (!existsSync(envFile)) {
      continue;
    }
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
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

function normalizeHandle(value) {
  return String(value ?? "").replace(/^@/, "").trim().toLowerCase();
}

function normalizeInstagramPostUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    if (!url.hostname.toLowerCase().endsWith("instagram.com")) {
      return raw;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `https://www.instagram.com/${parts[0]}/${parts[1]}/`;
    }
  } catch {
    return raw;
  }

  return raw;
}

function isApifyImageUrl(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase() === "images.apifyusercontent.com";
  } catch {
    return false;
  }
}

function pickApifyImageUrl(post) {
  const candidates = [post.imageUrl, ...(post.imageUrls ?? [])]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return candidates.find(isApifyImageUrl) ?? null;
}

function getConvexUrl() {
  loadEnvFiles();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
  }
  return convexUrl;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const convex = new ConvexHttpClient(getConvexUrl());
  const venues = await convex.query(api.venues.listVenues, {});
  const postsByUrl = new Map();

  for (const venue of venues) {
    const handle = normalizeHandle(venue.instagramHandle);
    if (!handle) {
      continue;
    }
    const posts = await convex.query(api.scrapedPosts.listByHandle, { handle });
    for (const post of posts) {
      const imageUrl = pickApifyImageUrl(post);
      const postUrl = normalizeInstagramPostUrl(post.instagramPostUrl);
      if (imageUrl && postUrl && !postsByUrl.has(postUrl)) {
        postsByUrl.set(postUrl, imageUrl);
      }
    }
  }

  const repairs = [];
  for (const status of options.statuses) {
    const events = await convex.query(api.events.listByStatus, {
      limit: options.limit,
      status,
    });
    for (const event of events) {
      const postUrl = normalizeInstagramPostUrl(event.instagramPostUrl);
      const nextImageUrl = postsByUrl.get(postUrl);
      if (!nextImageUrl || isApifyImageUrl(event.imageUrl)) {
        continue;
      }
      repairs.push({
        id: event._id,
        status: event.status,
        title: event.title,
        from: event.imageUrl ?? "",
        to: nextImageUrl,
      });
    }
  }

  for (const repair of repairs) {
    console.log(
      `${options.apply ? "patch" : "dry-run"} ${repair.id} [${repair.status}] ${repair.title}`,
    );
    console.log(`  from: ${repair.from || "(empty)"}`);
    console.log(`  to:   ${repair.to}`);
    if (options.apply) {
      await convex.mutation(api.events.updateEvent, {
        id: repair.id,
        patch: { imageUrl: repair.to },
      });
    }
  }

  console.log(
    `${options.apply ? "Patched" : "Would patch"} ${repairs.length} event image URLs.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
