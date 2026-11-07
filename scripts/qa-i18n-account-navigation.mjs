import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isPublicPagePath, localizeHref, stripLocalePrefix, LOCALE_LANGUAGE_TAGS } from "../i18n/config.ts";
import { accountMessages, accountText } from "../lib/i18n/account-messages.ts";
import { getSafeRedirectPath } from "../lib/auth/safe-redirect.ts";
import { getEmailSignInError, getEmailSignInStep } from "../lib/auth/email-sign-in.ts";
import { getMobileNavigationHref, canPrefetchMobileNavigation } from "../lib/navigation/mobile-navigation.ts";

for (const [key, translations] of Object.entries(accountMessages)) {
  assert.deepEqual(Object.keys(translations).sort(), ["en", "ru", "sr"], key);
  const placeholders = Object.values(translations).map(text => {
    assert.ok(text.trim(), `Empty account translation: ${key}`);
    return [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)].map(match => match[1]).sort();
  });
  assert.deepEqual(placeholders[0], placeholders[1], key);
  assert.deepEqual(placeholders[1], placeholders[2], key);
}
assert.equal(accountText("ru", "auth.codeSent", { email: "example@example.com" }), "Введите код, отправленный на example@example.com.");

for (const value of [null, "https://outside.invalid", "//outside.invalid", "/\\outside.invalid", "/sign-in", "/sign-up/code", "/sso-callback", "/en/sign-in", "/ru/sign-up?redirect_url=%2F", "/en/sso-callback/code", "/%65n/sign-in", "/en/%2e%2e/sign-in", "/bad\npath"]) {
  assert.equal(getSafeRedirectPath(value, "en"), null, String(value));
}
for (const locale of ["sr", "en", "ru"]) {
  const prefix = locale === "sr" ? "" : `/${locale}`;
  assert.equal(getSafeRedirectPath("/saved?date=2026-11-07#saved", locale), `${prefix}/saved?date=2026-11-07#saved`);
  assert.equal(getSafeRedirectPath("/events/event-id?day=2026-11-07", locale), `${prefix}/events/event-id?day=2026-11-07`);
  assert.equal(getSafeRedirectPath("/admin", locale), "/admin", "Operational paths remain unlocalized.");
  assert.equal(getMobileNavigationHref(`${prefix}/discover`, "2026-11-07"), `${prefix}/discover?date=2026-11-07`);
  assert.equal(getMobileNavigationHref(`${prefix}/map`, "2026-11-07"), `${prefix}/map`, "Map keeps its independent default date.");
  assert.equal(getMobileNavigationHref(prefix || "/", "2026-11-07"), `${prefix || "/"}?month=2026-11&day=2026-11-07`);
  for (const route of ["/", "/discover", "/map"]) assert.equal(canPrefetchMobileNavigation(localizeHref(route, locale)), true);
  for (const route of ["/saved", "/you", "/admin"]) assert.equal(canPrefetchMobileNavigation(localizeHref(route, locale)), false);
  assert.equal(getEmailSignInError({ errors: [{ code: "unknown", longMessage: "Provider internals" }] }, "Safe fallback", locale), "Safe fallback");
}
assert.match(getEmailSignInError({ errors: [{ code: "form_code_incorrect", message: "Wrong" }] }, "fallback", "ru"), /Неверный код/u);
assert.match(getEmailSignInError({ errors: [{ code: "form_password_incorrect" }] }, "fallback", "sr"), /nisu ispravni/u);

function loadComponent(path, imports) {
  const compiledModule = { exports: {} };
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, { exports: compiledModule.exports, require(name) {
    if (name in imports) return imports[name];
    throw new Error(`Unexpected localized component dependency: ${name}`);
  }, URLSearchParams, Map, Date, Set, requestAnimationFrame() {} });
  return compiledModule.exports;
}
const jsx = (type, props) => ({ type, props });
const hooks = { useEffect() {}, useLayoutEffect() {}, useCallback(callback) { return callback; }, useMemo(callback) { return callback(); }, useRef(value) { return { current: value }; }, useState(value) { return [value, () => {}]; }, useTransition() { return [false, callback => callback()]; } };
function resolve(node) {
  if (Array.isArray(node)) return node.flatMap(resolve);
  if (!node || typeof node !== "object") return [node];
  if (typeof node.type === "function") return resolve(node.type(node.props));
  return [{ ...node, children: resolve(node.props?.children) }];
}
function flatten(nodes) { return nodes.flatMap(node => node && typeof node === "object" ? [node, ...flatten(node.children ?? [])] : []); }
function text(node) { return (node?.children ?? []).map(child => typeof child === "object" ? text(child) : child ?? "").join(""); }

for (const locale of ["sr", "en", "ru"]) {
  const prefix = locale === "sr" ? "" : `/${locale}`;
  const icon = props => jsx("svg", props);
  const icons = Object.fromEntries(["Bookmark", "CalendarDays", "Instagram", "Loader2", "MapPin", "ShieldCheck", "Sparkles", "Telescope", "Warehouse"].map(name => [name, icon]));
  const toolbarModule = loadComponent("components/navigation/app-toolbar.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "react": hooks,
    "next/link": { default: "a" },
    "next/navigation": { usePathname: () => `${prefix}/discover`, useRouter: () => ({ push() {}, prefetch() {} }), useSearchParams: () => new URLSearchParams("date=2026-11-07") },
    "lucide-react": icons,
    "@/components/brand/event-zeka-brand": { EventZekaBrand: "brand" },
    "@/components/navigation/profile-avatar-link": { ProfileAvatarLink: "profile" },
    "@/components/navigation/language-switcher": { LanguageSwitcher: "language-switcher" },
    "@/components/providers/user-library-provider": { useUserLibrary: () => ({ upcomingSavedEventCount: 0 }) },
    "@/lib/seo/site": { SITE_INSTAGRAM_URL: "https://www.instagram.com/eventzeka/" },
    "@/lib/navigation/mobile-navigation": { getMobileNavigationHref, canPrefetchMobileNavigation },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "@/i18n/client": { useLocale: () => locale },
    "@/i18n/config": { isPublicPagePath, localizeHref, stripLocalePrefix },
    "@/lib/i18n/account-messages": { accountText },
  });
  const tree = flatten(resolve(toolbarModule.AppToolbar({})));
  const follows = tree.filter(node => node.type === "a" && node.props.href === "https://www.instagram.com/eventzeka/");
  assert.equal(follows.length, 2, "Both responsive headers retain their Instagram link.");
  for (const follow of follows) {
    assert.equal(text(follow), "Follow", "The Instagram Follow label stays visible beside the language picker.");
    assert.equal(follow.props.target, "_blank");
    assert.equal(follow.props.rel, "noopener noreferrer");
    assert.equal(follow.props["data-instagram-follow"], true);
    assert.ok(flatten(follow.children).some(node => node.type === "svg"), "Instagram icon stays present.");
  }
  assert.equal(tree.filter(node => node.type === "language-switcher").length, 2);
  assert.ok(tree.some(node => node.type === "a" && node.props.href === `${prefix}/saved?date=2026-11-07`));

  const switcher = loadComponent("components/navigation/language-switcher.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": { ...hooks, useState(value) { return [value === false ? true : value === "" ? "#details" : value, () => {}]; } },
    "next/navigation": { usePathname: () => `${prefix}/events/exact-event`, useSearchParams: () => new URLSearchParams("day=2026-11-07&venue=id%3Aexact-venue") },
    "lucide-react": { Check: icon },
    "next/image": { default: "img" },
    "@/i18n/client": { useLocale: () => locale },
    "@/i18n/config": { localizeHref },
    "@/lib/i18n/account-messages": { accountText },
  });
  const switchTree = flatten(resolve(switcher.LanguageSwitcher()));
  const languageLinks = switchTree.filter(node => node.type === "a");
  assert.equal(languageLinks.length, 3);
  assert.deepEqual(languageLinks.map(node => text(node)), ["Srpski", "English", "Русский"]);
  assert.deepEqual(languageLinks.map(node => node.props.href), ["", "/en", "/ru"].map(next => `${next}/events/exact-event?day=2026-11-07&venue=id%3Aexact-venue#details`));

  const authCard = loadComponent("components/auth/email-auth-card.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react": hooks,
    "next/link": { default: "a" },
    "@clerk/nextjs": { useSignIn: () => ({ isLoaded: true }), useSignUp: () => ({ isLoaded: true }) },
    "@/i18n/client": { useLocale: () => locale },
    "@/i18n/config": { localizeHref, LOCALE_LANGUAGE_TAGS },
    "@/lib/i18n/account-messages": { accountText },
    "@/lib/auth/safe-redirect": { getSafeRedirectPath },
    "@/lib/auth/email-sign-in": { getEmailSignInError, getEmailSignInStep },
  });
  for (const mode of ["sign-in", "sign-up"]) {
    const authNodes = flatten(resolve(authCard.EmailAuthCard({ mode })));
    assert.ok(authNodes.some(node => node.type === "h1" && text(node) === accountText(locale, mode === "sign-in" ? "auth.signIn" : "auth.signUp")));
    assert.ok(authNodes.some(node => node.props?.lang === LOCALE_LANGUAGE_TAGS[locale]));
    assert.ok(authNodes.some(node => node.type === "a" && node.props.href === (prefix || "/")), "Auth back link preserves the current locale.");
    assert.ok(authNodes.some(node => node.type === "input" && node.props.name === "email" && node.props.type === "email"));
    assert.ok(authNodes.some(node => node.type === "input" && node.props.type === "password"));
  }

  const installIcons = Object.fromEntries(["ArrowLeft", "ArrowRight", "Bookmark", "Download", "EllipsisVertical", "Monitor", "Plus", "RefreshCw", "Search", "Share"].map(name => [name, icon]));
  const guide = loadComponent("components/install/install-guide.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "react": hooks,
    "next/link": { default: "a" }, "next/image": { default: "img" }, "lucide-react": installIcons,
    "@/i18n/client": { useLocale: () => locale },
    "@/i18n/config": { localizeHref, LOCALE_LANGUAGE_TAGS },
    "@/lib/i18n/account-messages": { accountText },
    "@/lib/install/guide-landing": { startInstallGuideLanding() {} },
    "./install-guide.module.css": { default: {} },
  });
  const guideNodes = flatten(resolve(guide.InstallGuide()));
  assert.ok(guideNodes.some(node => node.type === "main" && node.props.lang === LOCALE_LANGUAGE_TAGS[locale]));
  assert.ok(guideNodes.some(node => node.type === "h2" && text(node) === accountText(locale, "install.instructions")));
  assert.ok(guideNodes.some(node => node.type === "button" && text(node) === accountText(locale, "install.computer")));
  assert.ok(guideNodes.some(node => node.type === "strong" && node.props.lang === "en" && text(node) === "Add to Home Screen"), "Illustrated browser menu labels remain exact, even in translated instructions.");
}

console.log(`Locale account/navigation QA passed: ${Object.keys(accountMessages).length} complete messages, safe auth returns, private prefetch isolation, all three language links and preserved Instagram Follow in both headers.`);
