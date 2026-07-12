import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import nextConfig from "../next.config.mjs";

const toolbarPath = "components/navigation/app-toolbar.tsx";
const source = readFileSync(toolbarPath, "utf8");
const layoutSource = readFileSync("app/layout.tsx", "utf8");
const navigationFeedbackSource = readFileSync(
  "components/navigation/navigation-feedback.tsx",
  "utf8",
);
const globalsSource = readFileSync("app/globals.css", "utf8");
const profileAvatarSource = readFileSync(
  "components/navigation/profile-avatar-link.tsx",
  "utf8",
);
const redirects = await nextConfig.redirects();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const mobileTopbarStart = source.indexOf('<div className="mobile-topbar">');
assert.notEqual(mobileTopbarStart, -1, "App toolbar should render a mobile top header.");

const desktopHeaderStart = source.indexOf("<header", mobileTopbarStart);
assert.notEqual(
  desktopHeaderStart,
  -1,
  "Mobile top header source should be separable from the desktop header.",
);

const mobileTopbarSource = source.slice(mobileTopbarStart, desktopHeaderStart);

const mobileNavStart = source.indexOf('<nav className="mobile-nav-shell"', desktopHeaderStart);
assert.notEqual(
  mobileNavStart,
  -1,
  "Desktop header source should be separable from the mobile bottom navigation.",
);

const desktopHeaderSource = source.slice(desktopHeaderStart, mobileNavStart);

assert.ok(
  mobileTopbarSource.includes("Belgrade nights"),
  "Mobile top header should keep the left brand label.",
);

assert.ok(
  mobileTopbarSource.includes("<ProfileAvatarLink />"),
  "Mobile top header should include the shared profile avatar.",
);

assert.ok(
  profileAvatarSource.includes('aria-label="Your profile"'),
  "Mobile top header should include a profile avatar link.",
);

assert.ok(
  profileAvatarSource.includes('href="/you"'),
  "Shared profile avatar should link to /you.",
);

assert.ok(
  profileAvatarSource.includes('title="Your profile"'),
  "Shared profile avatar should expose a title for desktop hover context.",
);

assert.ok(
  profileAvatarSource.includes("CircleUserRound"),
  "Shared profile avatar should render the profile icon.",
);

assert.ok(
  profileAvatarSource.includes('aria-current={isActive ? "page" : undefined}'),
  "Shared profile avatar should expose active page semantics when requested.",
);

assert.ok(
  desktopHeaderSource.includes('<ProfileAvatarLink isActive={pathname === "/you"} variant="desktop" />'),
  "Desktop header should include a profile avatar link to the You page.",
);

assert.equal(
  /\bcurrentSectionLabel\b/.test(source),
  false,
  "App toolbar should not derive or render a current-section label in the top header.",
);

assert.equal(
  mobileTopbarSource.includes("app-chip"),
  false,
  "Mobile top header should not render the old right-side current-tab chip.",
);

for (const label of ["Events", "Discover", "Venues", "Saved", "You"]) {
  assert.equal(
    new RegExp(`>\\s*${escapeRegExp(label)}\\s*<`).test(mobileTopbarSource),
    false,
    `Mobile top header should not repeat the ${label} bottom-nav label.`,
  );
}

assert.equal(
  /\b(pathname|isActivePath|desktopToolbarItems|mobileToolbarItems)\b/.test(mobileTopbarSource),
  false,
  "Mobile top header markup should be path/tab-independent so it stays identical on Events, Venues, Saved, and You.",
);

const publicItemsStart = source.indexOf("const PUBLIC_TOOLBAR_ITEMS");
assert.notEqual(publicItemsStart, -1, "App toolbar should keep explicit public toolbar items.");

const adminItemsStart = source.indexOf("const ADMIN_TOOLBAR_ITEMS", publicItemsStart);
assert.notEqual(
  adminItemsStart,
  -1,
  "Public toolbar item source should be separable from admin toolbar items.",
);

const publicItemsSource = source.slice(publicItemsStart, adminItemsStart);

assert.deepEqual(
  [...publicItemsSource.matchAll(/\blabel:\s*"([^"]+)"/g)].map(([, label]) => label),
  ["Events", "Discover", "Venues", "Saved"],
  "Public navigation tabs should remain exactly Events, Discover, Venues, Saved.",
);

for (const { href, label } of [
  { href: "/", label: "Events" },
  { href: "/discover", label: "Discover" },
  { href: "/venues", label: "Venues" },
  { href: "/saved", label: "Saved" },
]) {
  assert.match(
    publicItemsSource,
    new RegExp(`href:\\s*"${escapeRegExp(href)}"[\\s\\S]*?label:\\s*"${escapeRegExp(label)}"`),
    `Public toolbar should keep ${label} mapped to ${href}.`,
  );
}

assert.equal(
  /href:\s*"\/map"|label:\s*"Map"/.test(publicItemsSource),
  false,
  "Primary navigation should not expose the placeholder Map destination.",
);
assert.deepEqual(
  redirects.find(({ source }) => source === "/map"),
  {
    source: "/map",
    destination: "/venues",
    permanent: false,
  },
  "Next config should issue a non-permanent HTTP redirect from /map to /venues.",
);
assert.ok(
  source.includes('aria-label="Global"') && source.includes('aria-label="Mobile navigation"'),
  "Desktop and mobile primary navigation should retain accessible names.",
);
assert.ok(
  source.includes('aria-current={active ? "page" : undefined}'),
  "Primary navigation links should expose the active destination with aria-current.",
);
assert.ok(
  source.includes('className="flex w-full items-center gap-1 overflow-hidden"') &&
    source.includes("inline-flex min-w-0 flex-1 flex-col") &&
    source.includes('className="max-w-full truncate"'),
  "Mobile primary navigation should keep four flexible, truncating tabs without horizontal overflow at 320px.",
);

assert.ok(
  layoutSource.includes("<Suspense fallback={null}>") && layoutSource.includes("<NavigationFeedback />"),
  "Root layout should mount global navigation feedback inside Suspense so taps acknowledge immediately without CSR bailout build errors.",
);
assert.ok(
  navigationFeedbackSource.includes("window.addEventListener(\"pointerdown\""),
  "Navigation feedback should start on pointerdown for immediate mobile tap response.",
);
assert.ok(
  navigationFeedbackSource.includes('data-navigation-feedback="true"'),
  "Navigation feedback should expose a stable DOM marker for smoke tests.",
);
assert.ok(
  navigationFeedbackSource.includes("usePathname()") && navigationFeedbackSource.includes("useSearchParams()"),
  "Navigation feedback should clear pending state when App Router URL state changes.",
);
assert.ok(
  navigationFeedbackSource.includes("shouldUseDocumentNavigation") &&
    navigationFeedbackSource.includes("window.location.assign(href)") &&
    navigationFeedbackSource.includes("event.stopImmediatePropagation()"),
  "Same-page calendar query links should bypass App Router soft navigation and start a document navigation immediately.",
);
assert.ok(
  globalsSource.includes("touch-action: manipulation;"),
  "Interactive controls should use touch-action: manipulation for responsive mobile taps.",
);
assert.ok(
  globalsSource.includes("@keyframes navigation-feedback"),
  "Global CSS should keep the navigation feedback progress animation.",
);

console.log("QA passed: app toolbar top header is brand-only and tab-independent, with tap feedback.");
