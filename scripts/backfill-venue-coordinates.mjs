import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { jsonToConvex } from "convex/values";

const PATCH_FUNCTION = "_system/frontend/patchDocumentsFields:default";
const READ_QUERY = `import { query } from "convex:/_system/repl/wrappers.js";
export default query({handler: async (ctx, args) => ctx.db.get(args.id)});`;

export function validateManifest(manifest) {
  const origin = new URL(manifest.convexOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.origin !== manifest.convexOrigin) {
    throw new Error("Manifest must identify an exact public HTTPS Convex origin.");
  }
  if (!Array.isArray(manifest.venues) || !manifest.venues.length || manifest.venues.length > 2000) {
    throw new Error("Provide between 1 and 2000 reviewed venues.");
  }
  const ids = new Set();
  for (const venue of manifest.venues) {
    if (typeof venue.id !== "string" || !/^[a-z0-9]{20,40}$/.test(venue.id) || ids.has(venue.id)) {
      throw new Error("Each reviewed venue needs a unique exact Convex ID.");
    }
    ids.add(venue.id);
    if (!venue.name?.trim() || !venue.instagramHandle?.trim() || !Number.isFinite(venue.expectedUpdatedAt)) {
      throw new Error("Each venue needs its reviewed name, handle, and revision.");
    }
    if (venue.address !== undefined && (typeof venue.address !== "string" || !venue.address.trim() || venue.address.length > 300)) {
      throw new Error("A reviewed display address must be a nonempty string of at most 300 characters.");
    }
    if (!Number.isFinite(venue.latitude) || !Number.isFinite(venue.longitude) ||
      venue.latitude < -90 || venue.latitude > 90 || venue.longitude < -180 || venue.longitude > 180 ||
      (venue.latitude === 0 && venue.longitude === 0)) {
      throw new Error("Each venue needs a valid nonzero coordinate pair.");
    }
    if (!Array.isArray(venue.sourceUrls) || !venue.sourceUrls.length || venue.sourceUrls.length > 5) {
      throw new Error("Each venue needs between 1 and 5 public evidence URLs.");
    }
    for (const source of venue.sourceUrls) {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Evidence URLs must be public HTTPS URLs.");
    }
  }
  return manifest;
}

export function reviewVenue(current, reviewed) {
  if (!current || current._id !== reviewed.id || current.name !== reviewed.name || current.instagramHandle !== reviewed.instagramHandle) {
    throw new Error(`Reviewed venue identity changed: ${reviewed.id}`);
  }
  if (current.publicStatus !== "published" && !(current.publicStatus === undefined && current.isActive === true)) {
    throw new Error(`Venue is no longer published: ${reviewed.id}`);
  }
  if (current.latitude === reviewed.latitude && current.longitude === reviewed.longitude) return "already_set";
  if (current.latitude !== undefined || current.longitude !== undefined) throw new Error(`Refusing to overwrite coordinates: ${reviewed.id}`);
  if (current.updatedAt !== reviewed.expectedUpdatedAt) throw new Error(`Venue revision changed: ${reviewed.id}`);
  return "ready";
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

export function assertCoordinateOnlyChange(before, after, reviewed) {
  if (!after || after.latitude !== reviewed.latitude || after.longitude !== reviewed.longitude ||
    !Number.isSafeInteger(after.updatedAt) || after.updatedAt <= before.updatedAt) {
    throw new Error(`Coordinate verification failed: ${reviewed.id}`);
  }
  const withoutCoordinates = (venue) => Object.fromEntries(Object.entries(venue).filter(([key]) => !["latitude", "longitude", "updatedAt"].includes(key)));
  if (stableJson(withoutCoordinates(before)) !== stableJson(withoutCoordinates(after))) {
    throw new Error(`Other venue fields changed during verification: ${reviewed.id}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (["--manifest", "--receipt", "--expect-origin"].includes(flag) && argv[index + 1]) options[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!options.manifest || !options.receipt || !options["expect-origin"]) {
    throw new Error("Usage: node scripts/backfill-venue-coordinates.mjs --manifest FILE --receipt FILE --expect-origin HTTPS_ORIGIN [--apply]");
  }
  const manifest = validateManifest(JSON.parse(await readFile(options.manifest, "utf8")));
  const origin = process.env.CONVEX_SELF_HOSTED_URL?.replace(/\/+$/, "");
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (origin !== manifest.convexOrigin || origin !== options["expect-origin"] || !adminKey) {
    throw new Error("Explicit target, manifest origin, and private self-hosted credentials must agree.");
  }
  const client = new ConvexHttpClient(origin);
  client.setAdminAuth(adminKey);
  async function readVenue(id) {
    const response = await fetch(`${origin}/api/run_test_function`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adminKey, args: { id }, bundle: { path: "testQuery.js", source: READ_QUERY }, format: "convex_encoded_json" }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "success") throw new Error(`Could not read venue ${id} (HTTP ${response.status}).`);
    return jsonToConvex(result.value);
  }
  async function deploymentFingerprint() {
    const response = await fetch(`${origin}/api/get_config_hashes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adminKey }),
    });
    if (!response.ok) throw new Error(`Cannot verify deployed module hashes (HTTP ${response.status}).`);
    const modules = await response.json();
    const schema = await client.query("_system/frontend/getSchemas:default", { componentId: null });
    return createHash("sha256").update(stableJson({ modules, schema })).digest("hex");
  }
  const fingerprint = await deploymentFingerprint();
  // Validate the whole reviewed plan before any write; each row is then read
  // again immediately before its exact-ID patch. Receipts record partial runs.
  for (const reviewed of manifest.venues) reviewVenue(await readVenue(reviewed.id), reviewed);
  const receipt = { origin, apply: Boolean(options.apply), startedAt: new Date().toISOString(), deploymentFingerprint: fingerprint, results: [] };
  async function saveReceipt() {
    const temporary = `${options.receipt}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, options.receipt);
  }
  await saveReceipt();
  try {
    for (const reviewed of manifest.venues) {
      const before = await readVenue(reviewed.id);
      const status = reviewVenue(before, reviewed);
      const entry = { id: reviewed.id, name: reviewed.name, status, sourceUrls: reviewed.sourceUrls };
      if (options.apply && status === "ready") {
        if (await deploymentFingerprint() !== fingerprint) throw new Error("Backend deployment changed during the backfill.");
        // This system mutation has no conditional revision argument. Re-read
        // immediately before patching, after the deployment check.
        const fresh = await readVenue(reviewed.id);
        if (reviewVenue(fresh, reviewed) !== "ready") throw new Error(`Venue changed before patch: ${reviewed.id}`);
        entry.before = fresh;
        entry.status = "applying";
        receipt.results.push(entry);
        await saveReceipt();
        const result = await client.mutation(PATCH_FUNCTION, {
          table: "venues", ids: [reviewed.id], componentId: null,
          fields: { latitude: reviewed.latitude, longitude: reviewed.longitude, updatedAt: Math.max(Date.now(), fresh.updatedAt + 1) },
        });
        if (!result.success) throw new Error(`Coordinate patch failed: ${reviewed.id}`);
        const after = await readVenue(reviewed.id);
        assertCoordinateOnlyChange(fresh, after, reviewed);
        entry.after = after;
        entry.status = "updated";
      } else receipt.results.push(entry);
      await saveReceipt();
    }
    if (await deploymentFingerprint() !== fingerprint) throw new Error("Backend deployment fingerprint changed.");
    receipt.completedAt = new Date().toISOString();
    receipt.deploymentUnchanged = true;
    await saveReceipt();
    console.log(JSON.stringify({ apply: receipt.apply, reviewed: receipt.results.length, updated: receipt.results.filter((row) => row.status === "updated").length, deploymentUnchanged: true }));
  } catch (error) {
    receipt.failedAt = new Date().toISOString();
    receipt.error = error.message;
    await saveReceipt();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
