import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const guardrailsSource = read("lib/images/image-response-guardrails.ts");
const imagePrepSource = read("lib/ai/prepare-image-for-openai.ts");
const discoverImageRouteSource = read("app/api/discover/images/[eventId]/route.ts");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

assert.match(
  guardrailsSource,
  /DEFAULT_MAX_IMAGE_BYTES = 8 \* 1024 \* 1024/,
  "image guardrails should cap responses at 8 MB.",
);
assert.match(
  guardrailsSource,
  /RASTER_IMAGE_CONTENT_TYPES/,
  "image guardrails should define an allowlist of raster content types.",
);
assert.match(
  guardrailsSource,
  /content-length/,
  "image guardrails should check content-length before reading the body.",
);
assert.match(
  guardrailsSource,
  /response\.body\.getReader\(\)/,
  "image guardrails should stream response bodies through a byte counter.",
);
assert.match(
  imagePrepSource,
  /assertImageResponseHeaders/,
  "OpenAI image prep should validate image response headers.",
);
assert.match(
  imagePrepSource,
  /readImageResponseBodyWithLimit/,
  "OpenAI image prep should read images through the shared byte limit.",
);
assert.match(
  imagePrepSource,
  /finally\s*\{\s*clearTimeout\(timeoutId\);/s,
  "OpenAI image prep should clear abort timers in finally.",
);
assert.match(
  discoverImageRouteSource,
  /assertImageResponseHeaders/,
  "Discover image proxy should validate image response headers.",
);
assert.match(
  discoverImageRouteSource,
  /readImageResponseBodyWithLimit/,
  "Discover image proxy should enforce the streamed byte limit.",
);
assert.match(
  discoverImageRouteSource,
  /"x-content-type-options": "nosniff"/,
  "Discover image proxy should set nosniff.",
);
assert.ok(
  packageJson.scripts["qa:image-guardrails"]?.includes("qa-image-guardrails.mjs"),
  "package.json should expose qa:image-guardrails.",
);
assert.match(
  releaseCheckSource,
  /qa:image-guardrails/,
  "Release gate should include image guardrail QA.",
);

console.log("Image guardrail QA passed.");
