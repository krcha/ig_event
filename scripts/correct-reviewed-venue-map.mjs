import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { jsonToConvex } from "convex/values";
import { validateManifest } from "./backfill-venue-coordinates.mjs";

const READ_QUERY = `import { query } from "convex:/_system/repl/wrappers.js";
export default query({handler: async (ctx, args) => ctx.db.get(args.id)});`;
const PATCH_FUNCTION = "_system/frontend/patchDocumentsFields:default";
const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const hash = (value) => createHash("sha256").update(stableJson(value)).digest("hex");

export function validateCorrection(plan) {
  if (!plan || typeof plan !== "object" || !plan.venue) throw new Error("Provide one reviewed venue correction.");
  const venue = plan.venue;
  validateManifest({ convexOrigin: plan.convexOrigin, venues: [venue] });
  if (!Number.isSafeInteger(venue.expectedUpdatedAt) || venue.expectedUpdatedAt < 1 ||
    !Number.isFinite(venue.expectedLatitude) || !Number.isFinite(venue.expectedLongitude) ||
    venue.expectedLatitude < -90 || venue.expectedLatitude > 90 || venue.expectedLongitude < -180 || venue.expectedLongitude > 180 ||
    !(venue.expectedLocation === null || typeof venue.expectedLocation === "string") ||
    typeof venue.address !== "string" || !venue.address.trim() ||
    typeof venue.reviewNote !== "string" || venue.reviewNote.trim().length < 30 || venue.reviewNote.length > 4000) {
    throw new Error("Correction requires exact old revision, coordinates, address (or null), new address, and a substantive review note.");
  }
  if (venue.expectedLatitude === venue.latitude && venue.expectedLongitude === venue.longitude && venue.expectedLocation === venue.address) {
    throw new Error("Correction must identify a changed reviewed map location.");
  }
  return plan;
}

export function reviewCorrection(current, venue) {
  if (!current || current._id !== venue.id || current.name !== venue.name || current.instagramHandle !== venue.instagramHandle) {
    throw new Error(`Reviewed venue identity changed: ${venue.id}`);
  }
  if (current.publicStatus !== "published" && !(current.publicStatus === undefined && current.isActive === true)) {
    throw new Error(`Reviewed venue is no longer published: ${venue.id}`);
  }
  if (current.latitude === venue.latitude && current.longitude === venue.longitude && current.location === venue.address) return "already_set";
  if (current.updatedAt !== venue.expectedUpdatedAt || current.latitude !== venue.expectedLatitude ||
    current.longitude !== venue.expectedLongitude || (current.location ?? null) !== venue.expectedLocation) {
    throw new Error(`Reviewed venue revision or old map location changed: ${venue.id}`);
  }
  return "ready";
}

export function assertMapOnlyChange(before, after, venue) {
  if (!after || after.latitude !== venue.latitude || after.longitude !== venue.longitude || after.location !== venue.address ||
    !Number.isSafeInteger(after.updatedAt) || after.updatedAt <= before.updatedAt) {
    throw new Error(`Reviewed map readback failed: ${venue.id}`);
  }
  const unchanged = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["latitude", "longitude", "location", "updatedAt"].includes(key)));
  if (stableJson(unchanged(before)) !== stableJson(unchanged(after))) throw new Error(`Unrelated venue fields changed: ${venue.id}`);
}

// The system maintenance mutation has no atomic revision condition. The exact
// before snapshot is persisted first, then re-read immediately before patching;
// operators must avoid concurrent venue edits and retain the verified receipt.
export async function runCorrection(plan, { apply = false, expectedFingerprint, expectedPlanHash }, adapter) {
  validateCorrection(plan);
  const planHash = hash(plan);
  const fingerprint = await adapter.deploymentFingerprint();
  if (apply && (expectedFingerprint !== fingerprint || expectedPlanHash !== planHash)) {
    throw new Error("Apply requires the exact preview deployment fingerprint and plan hash.");
  }
  const before = await adapter.readVenue(plan.venue.id);
  const status = reviewCorrection(before, plan.venue);
  const receipt = {
    origin: plan.convexOrigin, apply, planHash, deploymentFingerprint: fingerprint,
    startedAt: new Date().toISOString(), status, reviewed: plan.venue, before,
  };
  await adapter.saveReceipt(receipt);
  try {
    if (apply && status === "ready") {
      receipt.status = "applying";
      // Saving must succeed before the patch. The before snapshot is retained
      // even when a network response is lost or post-write validation fails.
      await adapter.saveReceipt(receipt);
      if (await adapter.deploymentFingerprint() !== fingerprint) throw new Error("Backend deployment changed before correction.");
      const fresh = await adapter.readVenue(plan.venue.id);
      if (reviewCorrection(fresh, plan.venue) !== "ready" || stableJson(fresh) !== stableJson(before)) {
        throw new Error("Venue changed after the reviewed before snapshot.");
      }
      const fields = {
        latitude: plan.venue.latitude, longitude: plan.venue.longitude,
        location: plan.venue.address, updatedAt: Math.max(adapter.now(), fresh.updatedAt + 1),
      };
      await adapter.patchVenue(plan.venue.id, fields);
      receipt.after = await adapter.readVenue(plan.venue.id);
      assertMapOnlyChange(fresh, receipt.after, plan.venue);
      receipt.status = "updated";
    }
    if (await adapter.deploymentFingerprint() !== fingerprint) throw new Error("Backend deployment changed during correction.");
    receipt.completedAt = new Date().toISOString();
    receipt.deploymentUnchanged = true;
    await adapter.saveReceipt(receipt);
    return receipt;
  } catch (error) {
    receipt.failedAt = new Date().toISOString();
    receipt.error = error instanceof Error ? error.message : "Correction failed.";
    await adapter.saveReceipt(receipt);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (["--manifest", "--receipt", "--expect-origin", "--expect-fingerprint", "--expect-plan-hash"].includes(flag) && argv[index + 1]) options[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!options.manifest || !options.receipt || !options["expect-origin"]) {
    throw new Error("Usage: node scripts/correct-reviewed-venue-map.mjs --manifest FILE --receipt NEW_FILE --expect-origin HTTPS_ORIGIN [--apply --expect-fingerprint SHA256 --expect-plan-hash SHA256]");
  }
  const plan = validateCorrection(JSON.parse(await readFile(options.manifest, "utf8")));
  const origin = process.env.CONVEX_SELF_HOSTED_URL?.replace(/\/+$/, "");
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (origin !== plan.convexOrigin || origin !== options["expect-origin"] || !adminKey) {
    throw new Error("Explicit target, reviewed origin, and private self-hosted credentials must agree.");
  }
  // Refuse accidental receipt replacement, including a preview used for apply.
  await writeFile(options.receipt, "{}\n", { mode: 0o600, flag: "wx" });
  const client = new ConvexHttpClient(origin);
  client.setAdminAuth(adminKey);
  async function adminFetch(path, body) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminKey, ...body }),
    });
    if (!response.ok) throw new Error(`Convex maintenance read failed (HTTP ${response.status}).`);
    return response.json();
  }
  const receipt = await runCorrection(plan, {
    apply: Boolean(options.apply), expectedFingerprint: options["expect-fingerprint"], expectedPlanHash: options["expect-plan-hash"],
  }, {
    async readVenue(id) {
      const result = await adminFetch("/api/run_test_function", { args: { id }, bundle: { path: "testQuery.js", source: READ_QUERY }, format: "convex_encoded_json" });
      if (result.status !== "success") throw new Error(`Cannot read reviewed venue: ${id}`);
      return jsonToConvex(result.value);
    },
    async deploymentFingerprint() {
      const modules = await adminFetch("/api/get_config_hashes", {});
      const schema = await client.query("_system/frontend/getSchemas:default", { componentId: null });
      return hash({ modules, schema });
    },
    async patchVenue(id, fields) {
      const result = await client.mutation(PATCH_FUNCTION, { table: "venues", ids: [id], componentId: null, fields });
      if (!result.success) throw new Error(`Reviewed map patch failed: ${id}`);
    },
    async saveReceipt(value) {
      const temporary = `${options.receipt}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, options.receipt);
    },
    now: Date.now,
  });
  console.log(JSON.stringify({ apply: receipt.apply, status: receipt.status, planHash: receipt.planHash, deploymentFingerprint: receipt.deploymentFingerprint, deploymentUnchanged: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
