import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const layout = readFileSync("app/layout.tsx", "utf8");
const toolbar = readFileSync("components/navigation/app-toolbar.tsx", "utf8");
const brand = readFileSync("components/brand/event-zeka-brand.tsx", "utf8");
const manifest = readFileSync("app/manifest.ts", "utf8");
const icon = readFileSync("app/icon.svg", "utf8");
const openGraph = readFileSync("app/opengraph-image.tsx", "utf8");
const readme = readFileSync("README.md", "utf8");
const placeholderRoute = readFileSync("app/api/discover/images/[eventId]/route.ts", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const developmentPlan = readFileSync("DEVELOPMENT_PLAN.md", "utf8");

assert.ok(layout.includes('applicationName: "Event Zeka"'));
assert.ok(layout.includes('default: "Event Zeka — Belgrade events"'));
assert.ok(layout.includes('template: "%s | Event Zeka"'));
assert.ok(layout.includes('siteName: "Event Zeka"'));
assert.ok(layout.includes('manifest: "/manifest.webmanifest"'));

assert.ok(toolbar.includes("<EventZekaBrand compact />"));
assert.ok(toolbar.includes("<EventZekaBrand showTagline />"));
assert.equal([...toolbar.matchAll(/aria-label="Event Zeka home"/g)].length, 2);
assert.ok(brand.includes("Event Zeka"));
assert.ok(brand.includes("EventZekaMark"));
assert.ok(brand.includes("Belgrade, happening now"));
assert.equal(toolbar.includes("Belgrade nights"), false);
assert.equal(layout.includes("Belgrade Events — Nightlife calendar"), false);

assert.ok(manifest.includes('name: "Event Zeka"'));
assert.ok(manifest.includes('short_name: "Event Zeka"'));
assert.ok(manifest.includes('src: "/event-zeka-icon-192.png"'));
assert.ok(manifest.includes('src: "/event-zeka-icon-512.png"'));
assert.match(icon, /^<svg[\s\S]*<ellipse[\s\S]*<circle[\s\S]*<\/svg>\s*$/);
assert.ok(openGraph.includes("Event Zeka"));
assert.ok(openGraph.includes("Belgrade events,"));
assert.ok(openGraph.includes("happening now."));
assert.ok(readme.startsWith("# Event Zeka\n"));
assert.ok(placeholderRoute.includes(">Event Zeka</text>"));
assert.ok(architecture.includes("Event Zeka is a Next.js application"));
assert.ok(developmentPlan.startsWith("# Event Zeka Development Plan\n"));

for (const [path, expectedSize] of [
  ["app/apple-icon.png", 180],
  ["public/event-zeka-icon-192.png", 192],
  ["public/event-zeka-icon-512.png", 512],
]) {
  const metadata = await sharp(path).metadata();
  assert.equal(metadata.format, "png", `${path} should be PNG.`);
  assert.equal(metadata.width, expectedSize, `${path} should have the expected width.`);
  assert.equal(metadata.height, expectedSize, `${path} should have the expected height.`);
}

console.log("Event Zeka brand QA passed: lockup, metadata, manifest, icons, social image, and docs.");
