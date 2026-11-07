import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import * as localeConfig from "../i18n/config.ts";
import * as localizedSeo from "../lib/i18n/seo.ts";
import { accountText } from "../lib/i18n/account-messages.ts";
import { SITE_INSTAGRAM_URL } from "../lib/seo/site.ts";
import { getOgImageCopy } from "../lib/seo/og-image.ts";
import createManifest from "../app/manifest.ts";

const layout = readFileSync("app/layout.tsx", "utf8");
const toolbar = readFileSync("components/navigation/app-toolbar.tsx", "utf8");
const brand = readFileSync("components/brand/event-zeka-brand.tsx", "utf8");
const manifest = readFileSync("app/manifest.ts", "utf8");
const icon = readFileSync("app/icon.svg", "utf8");
const openGraph = readFileSync("lib/seo/og-image.ts", "utf8");
const openGraphRoute = readFileSync("app/api/og/route.ts", "utf8");
const legacyOpenGraphRoute = readFileSync("app/opengraph-image/route.ts", "utf8");
const readme = readFileSync("README.md", "utf8");
const placeholderRoute = readFileSync("app/api/discover/images/[eventId]/route.ts", "utf8");
const architecture = readFileSync("docs/architecture.md", "utf8");
const developmentPlan = readFileSync("DEVELOPMENT_PLAN.md", "utf8");

assert.ok(layout.includes('applicationName: "Event Zeka"'));
assert.ok(layout.includes('template: "%s | Event Zeka"'));
assert.ok(layout.includes('siteName: "Event Zeka"'));

function loadLayoutMetadata(locale) {
  const compiledModule = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx }, react: { Suspense: "suspense" },
    "@clerk/nextjs": { ClerkProvider: "clerk-provider" },
    "@/components/navigation/app-toolbar": { AppToolbar: "toolbar" },
    "@/components/navigation/navigation-feedback": { NavigationFeedback: "navigation-feedback" },
    "@/components/analytics/visitor-tracker": { VisitorTracker: "visitor-tracker" },
    "@/components/providers/auth-user-provider": { AuthUserProvider: "auth-provider" },
    "@/components/providers/user-library-provider": { UserLibraryProvider: "library-provider" },
    "@/components/calendar/events-ui-provider": { EventsUiProvider: "events-ui-provider" },
    "@/components/install/install-prompt": { InstallPrompt: "install-prompt" },
    "@/lib/seo/site": { SITE_ORIGIN: localizedSeo.SITE_ORIGIN },
    "@/lib/i18n/seo": localizedSeo,
    "@/i18n/client": { LocaleProvider: "locale-provider" },
    "@/i18n/config": localeConfig,
    "@/i18n/server": { getLocale: async () => locale },
    "./globals.css": {},
  };
  const code = ts.transpileModule(layout, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, { exports: compiledModule.exports, require(name) {
    if (name in imports) return imports[name];
    throw new Error(`Unexpected root brand dependency: ${name}`);
  }, URL, process: { env: {} } });
  return compiledModule.exports.generateMetadata();
}

for (const locale of localeConfig.LOCALES) {
  const metadata = await loadLayoutMetadata(locale);
  const copy = localizedSeo.SITE_COPY[locale];
  assert.equal(metadata.applicationName, "Event Zeka");
  assert.equal(metadata.title.default, `${copy.calendarTitle} | Event Zeka`);
  assert.equal(metadata.title.template, "%s | Event Zeka");
  assert.equal(metadata.openGraph.siteName, "Event Zeka");
  assert.equal(metadata.openGraph.locale, localizedSeo.OG_LOCALES[locale]);
  assert.equal(metadata.openGraph.url, localizedSeo.localizedAbsoluteUrl("/", locale));
  assert.equal(metadata.openGraph.images[0].url, `https://eventzeka.com/api/og?locale=${locale}`);
  assert.equal(metadata.manifest, `/api/manifest?locale=${locale}`);
  const imageCopy = getOgImageCopy(locale);
  assert.ok(imageCopy.headline.every(value => value.trim()));
  assert.ok(imageCopy.description.every(value => value.trim()));
  assert.equal(imageCopy.url, locale === "sr" ? "eventzeka.com" : `eventzeka.com/${locale}`);
}

assert.ok(toolbar.includes("<EventZekaBrand compact />"));
assert.ok(toolbar.includes("<EventZekaBrand showTagline />"));
assert.equal([...toolbar.matchAll(/aria-label=\{accountText\(locale, "nav.homeA11y"\)\}/g)].length, 2);
assert.equal(accountText("en", "nav.homeA11y"), "Event Zeka home");
assert.equal(SITE_INSTAGRAM_URL, "https://www.instagram.com/eventzeka/");
assert.ok(toolbar.includes("href={SITE_INSTAGRAM_URL}"), "The official Instagram destination must survive localization.");
assert.ok(toolbar.includes("<Instagram aria-hidden="));
assert.ok(toolbar.includes("<span>Follow</span>"), "The public Follow label stays beside the language picker.");
assert.ok(brand.includes("Event Zeka"));
assert.ok(brand.includes("EventZekaMark"));
assert.ok(brand.includes("Belgrade, happening now"));
assert.equal(toolbar.includes("Belgrade nights"), false);
assert.equal(layout.includes("Belgrade Events — Nightlife calendar"), false);

assert.ok(manifest.includes('name: "Event Zeka"'));
assert.ok(manifest.includes('short_name: "Event Zeka"'));
assert.ok(manifest.includes('src: "/event-zeka-icon-192.png"'));
assert.ok(manifest.includes('src: "/event-zeka-icon-512.png"'));
assert.equal(createManifest().id, "/", "All language launch URLs share the existing installed-app identity.");
assert.equal(createManifest().name, "Event Zeka");
assert.match(icon, /^<svg[\s\S]*<ellipse[\s\S]*<circle[\s\S]*<\/svg>\s*$/);
assert.ok(openGraph.includes("Event Zeka"));
assert.ok(openGraph.includes("Belgrade events,"));
assert.ok(openGraph.includes("happening now."));
assert.ok(openGraphRoute.includes("createOgImageHandler()"));
assert.ok(legacyOpenGraphRoute.includes('createOgImageHandler({ fixedLocale: "sr" })'), "The historical image URL remains available without a file-based metadata override.");
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

console.log("Event Zeka brand QA passed: localized metadata/social copy in all three languages, lockup, official Instagram Follow, stable app identity, original icons, image routes and docs.");
