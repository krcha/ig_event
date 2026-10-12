// Isolated real-carousel evaluation. No Convex clients, ingestion or database writes.
// All input bytes come from an independently retained, checksum-verified manifest.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
if (args.includes("--help")) {
  console.log("Usage: node --experimental-strip-types scripts/evaluate-instagram-carousel-posts.mjs --out /absolute/outside/repo --media-manifest /protected/manifest.json --variant baseline|candidate [--first-slide] [--code-root /absolute/repo] [--venue-snapshot /absolute/read-only-snapshot.json] [--key-file /protected/file --run] [--offline] [--case comma,separated,ids] [--concurrency 2]");
  process.exit(0);
}
const codeRoot = path.resolve(option("code-root", scriptRoot));
const out = option("out");
if (!out || !path.isAbsolute(out)) throw new Error("--out must be an absolute directory outside the repository.");
const outputRoot = path.resolve(out);
for (const root of [scriptRoot, codeRoot]) {
  if (outputRoot === root || outputRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("Evaluation artifacts must stay outside the repository.");
  }
}
const variant = option("variant", "candidate");
if (!/^[a-z0-9-]+$/.test(variant)) throw new Error("Use a simple variant name.");
const offline = args.includes("--offline");
if (!offline && !args.includes("--run")) throw new Error("Use --offline to rescore existing results, or --run with a protected key file for paid evaluation.");
const concurrency = Number(option("concurrency", "2"));
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("Concurrency must be 1 or 2.");
const fixturePath = path.resolve(option("fixtures", path.join(scriptRoot, "scripts/fixtures/instagram-real-carousels-2026-10-12.json")));
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));
const firstSlideOnly = args.includes("--first-slide");
const mediaManifestPath = option("media-manifest");
if (!mediaManifestPath || !path.isAbsolute(mediaManifestPath)) throw new Error("Supply an absolute retained --media-manifest.");
const retainedMedia = JSON.parse(await readFile(mediaManifestPath, "utf8"));
const retainedMediaRoot = path.resolve(path.dirname(mediaManifestPath), "media");
for (const entry of corpus.cases) {
  const manifest = retainedMedia.filter((image) => image.case === (entry.mediaCase ?? entry.id));
  if (manifest.length !== entry.post.imageSlideCount) throw new Error(`Source manifest count mismatch for ${entry.id}.`);
  const indexes = new Set();
  entry.post.imageSlides = manifest.map((image) => {
    if (indexes.has(image.slideIndex) || !Number.isInteger(image.slideIndex) || image.slideIndex < 0) throw new Error("Invalid or duplicate retained source index.");
    indexes.add(image.slideIndex);
    return { index: image.slideIndex, mediaType: image.mediaType === "Video" ? "video" : "image", imageUrls: image.sourceUrl ? [image.sourceUrl] : [] };
  }).sort((left, right) => left.index - right.index);
  entry.post.imageUrl = entry.post.imageSlides.find((slide) => slide.imageUrls.length)?.imageUrls[0] ?? null;
  entry.post.imageUrls = [...new Set(entry.post.imageSlides.flatMap((slide) => slide.imageUrls))];
  entry.retainedMedia = manifest;
}
const venueSnapshotPath = option("venue-snapshot");
const venueResolverSnapshot = venueSnapshotPath ? JSON.parse(await readFile(venueSnapshotPath, "utf8")) : null;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function sourceDigest(directory) {
  const digest = createHash("sha256");
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) digest.update(path.relative(directory, filename)).update(await readFile(filename));
    }
  }
  await visit(directory);
  return digest.digest("hex");
}
const codeDigestSha256 = sha((await Promise.all(["lib", "convex"].map((directory) => sourceDigest(path.join(codeRoot, directory))))).join(":"));
const corpusDigestSha256 = sha(JSON.stringify(corpus));
const venueSnapshotDigestSha256 = venueResolverSnapshot ? sha(JSON.stringify(venueResolverSnapshot)) : null;
const selected = option("case")?.split(",");
const cases = corpus.cases.filter((entry) => !selected || selected.includes(entry.id));
if (!cases.length || (selected && selected.some((id) => !cases.some((entry) => entry.id === id)))) throw new Error("Unknown or empty case selection.");
process.env.OPENAI_VISION_MODEL = "gpt-6-luna";
if (!offline) {
  const keyFile = option("key-file");
  if (!keyFile) throw new Error("Supply --key-file; credentials are never accepted as command-line values.");
  process.env.OPENAI_API_KEY = (await readFile(keyFile, "utf8")).trim();
  if (!process.env.OPENAI_API_KEY) throw new Error("The protected key file is empty.");
}
register(pathToFileURL(path.join(codeRoot, "scripts/ts-paths-loader.mjs")));
// The established QA entrypoint order avoids the ingestion module's circular
// initialization. Merely importing registered Convex functions performs no IO.
await import(pathToFileURL(path.join(codeRoot, "convex/events.ts")));
const { extractEventDataFromInstagramPost } = await import(pathToFileURL(path.join(codeRoot, "lib/ai/extract-event-data.ts")));
const { prepareEventsForInsert } = await import(pathToFileURL(path.join(codeRoot, "lib/pipeline/run-instagram-ingestion.ts")));
const imageCoverageModule = await import(pathToFileURL(path.join(codeRoot, "lib/pipeline/instagram-image-coverage.ts")));
const { TBD_EVENT_TIME } = await import(pathToFileURL(path.join(codeRoot, "lib/events/event-time.ts")));
const { normalizeToJpeg } = await import(pathToFileURL(path.join(codeRoot, "lib/ai/prepare-image-for-openai.ts")));
const { buildLegacyOperationalVenueRecords } = await import(pathToFileURL(path.join(codeRoot, "lib/pipeline/operational-venues.ts")));
const { buildCanonicalVenueNamesByHandle, buildCanonicalVenueAliasesByHandle, buildCanonicalVenueLocationsByHandle } = await import(pathToFileURL(path.join(codeRoot, "lib/pipeline/venue-normalization.ts")));
const operationalVenues = venueResolverSnapshot ? buildLegacyOperationalVenueRecords(venueResolverSnapshot) : null;

const storage = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const context = storage.getStore();
  if (!context) throw new Error("Evaluation blocks all network calls outside a case.");
  if (url.href === "https://api.openai.com/v1/responses") {
    if (offline || context.transportAttempts !== 0) throw new Error("Evaluation permits exactly one paid request per case and variant.");
    const request = JSON.parse(init.body);
    const submitted = (request.input ?? []).flatMap((item) => item.content ?? []).filter((content) => content.type === "input_image");
    if (submitted.length !== context.submittedImages.length || submitted.some((item, index) =>
      sha(Buffer.from(item.image_url.split(",")[1], "base64")) !== context.submittedImages[index].providerBytesSha256)) {
      throw new Error("Provider input does not exactly match the ordered retained carousel bytes.");
    }
    if (request.model !== "gpt-6-luna") throw new Error("Evaluation must use gpt-6-luna.");
    context.transportAttempts += 1;
    context.request = structuredClone(request);
    for (const item of context.request.input ?? []) {
      for (const content of item.content ?? []) {
        if (content.type === "input_image") {
          content.image_sha256 = sha(Buffer.from(content.image_url.split(",")[1], "base64"));
          content.image_url = "[retained source bytes omitted from report]";
        }
      }
    }
    const transportStarted = performance.now();
    const response = await nativeFetch(input, init);
    context.httpStatus = response.status;
    context.providerResponse = await response.clone().text();
    context.providerDurationMs = Math.round(performance.now() - transportStarted);
    return response;
  }
  throw new Error(`Evaluation blocked unexpected network destination: ${url.origin}`);
};

const comparable = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function matchesRow(row, rule) {
  for (const field of ["date", "time", "status"]) if (rule[field] && row[field] !== rule[field]) return false;
  if (rule.timeStartsWith && !String(row.time ?? "").startsWith(rule.timeStartsWith)) return false;
  for (const field of ["venue", "title", "description"]) if (rule[`${field}Contains`] && !comparable(row[field]).includes(comparable(rule[`${field}Contains`]))) return false;
  const artists = (row.artists ?? []).map(comparable);
  if (rule.artistContains && !artists.some((name) => name.includes(comparable(rule.artistContains)))) return false;
  if (rule.excludeArtistContains && artists.some((name) => name.includes(comparable(rule.excludeArtistContains)))) return false;
  return true;
}
function score(entry, result) {
  const rows = (result.prepared ?? []).filter((row) => row.kind === "ok").map((row) => ({ ...row.event, normalizedFields: row.normalizedFields }));
  const approved = rows.filter((row) => row.status === "approved");
  const raw = result.extracted;
  return entry.checks.map((check) => {
    let pass = false;
    let actual;
    switch (check.type) {
      case "non_event": actual = raw?.is_event; pass = actual === false && rows.length === 0; break;
      case "no_approved": actual = approved.length; pass = actual === 0; break;
      case "event_count": actual = check.allApproved ? { eventCount: rows.length, approvedCount: approved.length } : rows.length; pass = rows.length === check.value && (!check.allApproved || approved.length === rows.length); break;
      case "event_count_max": actual = rows.length; pass = actual <= check.value; break;
      case "unique_occurrences": {
        const signatures = rows.map((row) => [row.date, row.time ?? "", comparable(row.venue), comparable(row.title)].join("|"));
        actual = { rows: rows.length, unique: new Set(signatures).size }; pass = actual.rows === actual.unique; break;
      }
      case "all_times_unknown": actual = rows.map((row) => row.time ?? ""); pass = rows.length > 0 && actual.every((time) => time === "" || time === TBD_EVENT_TIME); break;
      case "all_venues_match": actual = rows.map((row) => row.venue ?? ""); pass = rows.length > 0 && actual.every((venue) => comparable(venue).includes(comparable(check.venueContains))); break;
      case "coverage_complete": actual = result.coverage?.complete; pass = actual === check.value; break;
      case "input_image_count": actual = result.sourceImages?.length; pass = actual === check.value; break;
      case "row_slide_binding": {
        actual = rows.filter((row) => matchesRow(row, check.match)).map((row) => row.normalizedFields?.carouselSourceSlideIndexes ?? []);
        // Populated by normalized facts below; occurrence evidence must include the exact retained source index.
        pass = actual.length > 0 && actual.every((indexes) => indexes.includes(check.slideIndex)); break;
      }
      case "approved_count": actual = approved.length; pass = actual === check.value; break;
      case "matching_count": actual = rows.filter((row) => matchesRow(row, check.match)).length; pass = actual === check.value; break;
      case "has_row": actual = rows.filter((row) => matchesRow(row, check.match)); pass = actual.length > 0; break;
      case "no_row": actual = rows.filter((row) => matchesRow(row, check.match)); pass = actual.length === 0; break;
      case "no_artist": actual = rows.flatMap((row) => row.artists ?? []).filter((artist) => check.names.some((name) => comparable(artist).includes(comparable(name)))); pass = actual.length === 0 && !raw?.artists?.some((artist) => check.names.some((name) => comparable(artist).includes(comparable(name)))); break;
      case "raw_conflict": actual = [...(raw?.source_conflicts ?? []), ...(raw?.schedule_entries ?? []).flatMap((row) => row.source_conflicts ?? [])].filter((conflict) => conflict.field === check.field); pass = actual.length > 0; break;
      case "description_contains": {
        actual = rows.map((row) => row.description ?? "");
        const contains = (description, term) => comparable(description).includes(comparable(term));
        pass = rows.length > 0 && (check.allRows
          ? actual.every((description) => check.terms.every((term) => contains(description, term)))
          : check.terms.every((term) => actual.some((description) => contains(description, term))));
        break;
      }
      case "time_provenance": actual = rows.filter((row) => matchesRow(row, check.match)).map((row) => row.timeEvidenceText); pass = actual.length > 0 && actual.every((text) => check.terms.some((term) => comparable(text).includes(comparable(term)))); break;
      default: throw new Error(`Unknown check type ${check.type}`);
    }
    return { label: check.label, type: check.type, pass, actual };
  });
}
function plan(entry, extracted) {
  const handle = entry.post.username;
  const names = operationalVenues ? buildCanonicalVenueNamesByHandle(operationalVenues) : Object.fromEntries((corpus.venueDirectory ?? []).map((venue) => [venue.handle, venue.name]));
  if (entry.context.canonicalVenueName) names[handle] = entry.context.canonicalVenueName;
  const aliases = operationalVenues ? buildCanonicalVenueAliasesByHandle(operationalVenues) : Object.fromEntries((corpus.venueDirectory ?? []).map((venue) => [venue.handle, venue.aliases]));
  const prepared = prepareEventsForInsert(entry.post, extracted, entry.post.imageUrl, names, {}, names, {
    eventDateFilterNow: new Date(corpus.evaluationNow),
    sourceRolesByHandle: { [handle]: entry.context.instagramSourceRole },
    canonicalVenueAliasesByHandle: aliases,
    ...(venueResolverSnapshot ? {
      venueResolverSnapshot,
      canonicalVenueLocationsByHandle: buildCanonicalVenueLocationsByHandle(operationalVenues),
    } : {}),
    rawExtractionJson: JSON.stringify(extracted),
  });
  return prepared.map((row) => row.kind === "ok" ? {
    kind: row.kind,
    event: Object.fromEntries(Object.entries(row.event).filter(([key]) => !["rawExtractionJson", "normalizedFieldsJson"].includes(key))),
    normalizedFields: row.normalizedFields,
  } : row);
}
function coverageForImages(entry, images) {
  const bindings = images.map((image) => ({ slideIndex: image.slideIndex,
    sourceUrl: image.url, checksumSha256: image.retainedBytesSha256 }));
  if (!firstSlideOnly) {
    if (!imageCoverageModule.buildInstagramCarouselImageCoverage) throw new Error("Joint-carousel code must provide explicit slide-index coverage.");
    return imageCoverageModule.buildInstagramCarouselImageCoverage(entry.post, bindings);
  }
  return imageCoverageModule.buildInstagramImageCoverage(entry.post, bindings.map((image) => image.sourceUrl));
}
await mkdir(path.join(outputRoot, variant), { recursive: true, mode: 0o700 });
await mkdir(path.join(outputRoot, "media"), { recursive: true });
async function evaluate(entry) {
  const resultFile = path.join(outputRoot, variant, `${entry.id}.json`);
  let previous;
  try { previous = JSON.parse(await readFile(resultFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // A durable record is created before transport. Re-running resumes saved
  // responses and never silently repeats an ambiguous or failed paid call.
  if (previous) {
    if (previous.extracted) {
      if (!offline && previous.codeDigestSha256 !== codeDigestSha256) throw new Error(`Saved ${entry.id} was generated by different code; rescore --offline or use a fresh explicit variant.`);
      if (previous.firstSlideOnly !== firstSlideOnly || previous.sourceDigestSha256 !== sha(JSON.stringify(entry.post))) throw new Error(`Saved ${entry.id} input differs; use a separately named explicit variant.`);
      const correctedCoverage = coverageForImages(entry, previous.sourceImages ?? []);
      // Coverage is wrapper-owned metadata, absent from the provider prompt and
      // output. Preserve the original provider receipt and extraction, and
      // replay only the independently recomputed caller metadata when an old
      // harness supplied legacy URL-based coverage for video thumbnails.
      if (JSON.stringify(correctedCoverage) !== JSON.stringify(previous.extracted._imageCoverage)) {
        previous.callerMetadataCorrection = {
          originalCoverage: previous.extracted._imageCoverage,
          recomputedCoverage: correctedCoverage,
          providerResponseSha256: sha(JSON.stringify(previous.providerResponse)),
          reason: "Explicit source-index coverage preserves unexamined video interiors; provider prompt and output are unchanged.",
          correctedAt: new Date().toISOString(),
        };
      }
      previous.coverage = correctedCoverage;
      previous.prepared = plan(entry, { ...previous.extracted, _imageCoverage: correctedCoverage });
      previous.checks = score(entry, previous);
      if (previous.error) {
        previous.previousErrors = [...(previous.previousErrors ?? []), previous.error];
        delete previous.error;
      }
      previous.status = "completed";
      previous.rescoredAt = new Date().toISOString();
      previous.rescoreCodeDigestSha256 = codeDigestSha256;
      previous.rescoreCorpusDigestSha256 = corpusDigestSha256;
      previous.rescoreVenueSnapshotDigestSha256 = venueSnapshotDigestSha256;
      await writeFile(resultFile, JSON.stringify(previous, null, 2), { mode: 0o600 });
    }
    return previous;
  }
  if (offline) throw new Error(`No saved response for ${entry.id}; offline mode cannot call providers.`);
  const context = { entry, transportAttempts: 0 };
  const result = { caseId: entry.id, title: entry.title, variant, model: "gpt-6-luna", codeRoot, codeDigestSha256, corpusDigestSha256, venueSnapshotDigestSha256, sourceInstagramPostUrl: entry.post.instagramPostUrl, evaluationNow: corpus.evaluationNow, sourceDigestSha256: sha(JSON.stringify(entry.post)), context: entry.context, firstSlideOnly, startedAt: new Date().toISOString(), transportAttempts: 0, status: "started" };
  await writeFile(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  const started = performance.now();
  try {
    await storage.run(context, async () => {
      const selectedMedia = entry.retainedMedia.filter((image) => image.status === "retained").sort((left, right) => left.slideIndex - right.slideIndex).slice(0, firstSlideOnly ? 1 : 20);
      if (!selectedMedia.length) throw new Error("No independently retained image inputs.");
      const imageDataUrls = [];
      const bindings = [];
      result.sourceImages = [];
      let normalizedByteCount = 0;
      for (const sourceImage of selectedMedia) {
        const retainedPath = path.resolve(sourceImage.localPath);
        if (!retainedPath.startsWith(`${retainedMediaRoot}${path.sep}`)) throw new Error("Retained media path escaped its owned directory.");
        const bytes = await readFile(retainedPath);
        if (bytes.length > 20 * 1024 * 1024 || sha(bytes) !== sourceImage.sha256) throw new Error("Retained carousel source checksum mismatch or image over limit.");
        const normalized = await normalizeToJpeg(bytes, sourceImage.contentType ?? "image/jpeg");
        normalizedByteCount += normalized.imageBuffer.length;
        if (normalizedByteCount > 24 * 1024 * 1024) throw new Error("Carousel normalized image payload exceeds 24 MiB.");
        result.sourceImages.push({ slideIndex: sourceImage.slideIndex, url: sourceImage.sourceUrl, mediaType: sourceImage.mediaType,
          retainedBytesSha256: sha(bytes), providerBytesSha256: sha(normalized.imageBuffer), byteLength: bytes.length });
        bindings.push({ slideIndex: sourceImage.slideIndex, sourceUrl: sourceImage.sourceUrl, checksumSha256: sha(bytes) });
        imageDataUrls.push(`data:${normalized.mimeType};base64,${normalized.imageBuffer.toString("base64")}`);
      }
      context.submittedImages = result.sourceImages;
      result.coverage = coverageForImages(entry, result.sourceImages);
      result.extracted = await extractEventDataFromInstagramPost({
        imageDataUrl: firstSlideOnly ? imageDataUrls[0] : undefined,
        ...(firstSlideOnly ? {} : { imageDataUrls, carouselImages: bindings, carouselKnownSlideCount: entry.post.imageSlideCount }),
        imageCoverage: result.coverage,
        caption: entry.post.caption,
        altText: entry.post.altText,
        instagramPostUrl: entry.post.instagramPostUrl,
        sourceImageUrl: entry.post.imageUrl,
        instagramHandle: entry.post.username,
        instagramPostTimestamp: entry.post.postedAt,
        extractionMode: "poster",
        ...entry.context,
        beforeTransport: async () => {
          // Reserve the only attempt before sending, so process interruption
          // cannot become an invisible automatic paid retry.
          result.status = "transport_reserved";
          result.transportAttempts = 1;
          await writeFile(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
        },
      });
      result.prepared = plan(entry, result.extracted);
      result.checks = score(entry, result);
      result.status = "completed";
    });
  } catch (error) {
    result.status = "failed";
    result.error = { name: error.name, message: String(error.message).replaceAll(process.env.OPENAI_API_KEY, "[redacted]") };
  }
  result.transportAttempts = Math.max(result.transportAttempts, context.transportAttempts);
  result.httpStatus = context.httpStatus;
  result.providerDurationMs = context.providerDurationMs;
  result.request = context.request;
  if (context.providerResponse) {
    try { result.providerResponse = JSON.parse(context.providerResponse); } catch { result.providerResponse = context.providerResponse; }
  }
  result.durationMs = Math.round(performance.now() - started);
  result.completedAt = new Date().toISOString();
  await writeFile(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`${variant} ${entry.id}: ${result.status}; ${result.checks?.filter((check) => check.pass).length ?? 0}/${entry.checks.length} checks; ${result.durationMs}ms`);
  return result;
}
let cursor = 0;
const results = [];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < cases.length) {
    const entry = cases[cursor++];
    results.push(await evaluate(entry));
  }
}));
const checks = results.flatMap((result) => result.checks ?? []);
const protocolCheckTypes = new Set(["coverage_complete", "input_image_count", "row_slide_binding"]);
const behaviorChecks = checks.filter((check) => !protocolCheckTypes.has(check.type));
const usage = results.map((result) => result.extracted?._openaiUsage ?? result.providerResponse?.usage);
const summary = {
  variant, model: "gpt-6-luna", firstSlideOnly, codeRoot, codeDigestSha256, corpusDigestSha256, venueSnapshotDigestSha256, evaluationNow: corpus.evaluationNow,
  caseCount: cases.length,
  completedCount: results.filter((result) => result.status === "completed").length,
  passedCaseCount: results.filter((result) => result.status === "completed" && result.checks?.every((check) => check.pass)).length,
  checkCount: checks.length, passedCheckCount: checks.filter((check) => check.pass).length,
  behaviorCheckCount: behaviorChecks.length, passedBehaviorCheckCount: behaviorChecks.filter((check) => check.pass).length,
  passedBehaviorCaseCount: results.filter((result) => result.status === "completed" && result.checks?.filter((check) => !protocolCheckTypes.has(check.type)).every((check) => check.pass)).length,
  transportAttempts: results.reduce((sum, result) => sum + (result.transportAttempts ?? 0), 0),
  inputTokens: usage.reduce((sum, item) => sum + (item?.inputTokens ?? item?.input_tokens ?? 0), 0),
  outputTokens: usage.reduce((sum, item) => sum + (item?.outputTokens ?? item?.output_tokens ?? 0), 0),
  reasoningTokens: usage.reduce((sum, item) => sum + (item?.reasoningTokens ?? item?.output_tokens_details?.reasoning_tokens ?? 0), 0),
  limitations: corpus.limitations,
  cases: results.map((result) => {
    const events = (result.prepared ?? []).filter((row) => row.kind === "ok").map((row) => row.event);
    return {
      id: result.caseId, status: result.status, durationMs: result.durationMs,
      plannedEventCount: events.length,
      approvedEventCount: events.filter((event) => event.status === "approved").length,
      pendingEventCount: events.filter((event) => event.status === "pending").length,
      approvedWithoutVenueCount: events.filter((event) => event.status === "approved" && !String(event.venue ?? "").trim()).length,
      failedChecks: result.checks?.filter((check) => !check.pass).map((check) => check.label) ?? [], error: result.error,
    };
  }),
};
await writeFile(path.join(outputRoot, variant, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
globalThis.fetch = nativeFetch;
if (summary.completedCount !== summary.caseCount || summary.passedCaseCount !== summary.caseCount) process.exitCode = 1;
