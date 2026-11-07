import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as localeConfig from "../i18n/config.ts";
import nextConfig from "../next.config.mjs";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const { localizeHref, stripLocalePrefix, resolveLocaleRequestPath } = localeConfig;

for (const locale of ["sr", "en", "ru"]) {
  const prefix = locale === "sr" ? "" : `/${locale}`;
  for (const route of ["/", "/discover", "/map", "/saved", "/you", "/install", "/events/event_123", "/venues/venue_123", "/venues/directory", "/sign-in/verify", "/sign-up"]) {
    const localized = localizeHref(`${route}?date=2026-11-07&q=a%26b#details`, locale);
    assert.equal(localized, `${prefix}${route === "/" ? "" : route}${route === "/" && !prefix ? "/" : ""}?date=2026-11-07&q=a%26b#details`);
    assert.equal(stripLocalePrefix(localized), `${route}?date=2026-11-07&q=a%26b#details`);
    for (const previous of ["sr", "en", "ru"]) {
      assert.equal(localizeHref(localizeHref(route, previous), locale), localizeHref(route, locale));
    }
  }
  for (const stable of ["/api/user/library", "/api/admin/events", "/api/cron/ingest-venues", "/admin", "/admin/scraper", "/sso-callback", "/fonts/a.woff2", "/images/poster.jpg", "https://www.instagram.com/eventzeka/", "//example.com/a", "mailto:a@example.com", "#details", "?date=2026-11-07"]) {
    assert.equal(localizeHref(stable, locale), stable, `Stable operation or external URL: ${stable}`);
  }
}
assert.equal(stripLocalePrefix("/english"), "/english");
assert.equal(stripLocalePrefix("/envelope/map"), "/envelope/map");
assert.deepEqual(resolveLocaleRequestPath("/ru/events/event_123"), { kind: "rewrite", locale: "ru", pathname: "/events/event_123" });
assert.deepEqual(resolveLocaleRequestPath("/sr/discover"), { kind: "redirect", locale: "sr", pathname: "/discover" });
for (const prefix of ["en", "ru", "sr"]) {
  for (const path of ["/admin", "/admin/scraper", "/api/user/library", "/api/admin/events", "/api/cron/ingest-venues", "/sso-callback", "/fonts/a.woff2", "/_next/static/test.js", "/not-a-public-route"]) {
    assert.equal(resolveLocaleRequestPath(`/${prefix}${path}`).kind, "not_found");
  }
}

const middlewareSource = readFileSync("middleware.ts", "utf8");
const compiled = ts.transpileModule(middlewareSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadMiddleware({ configured = false, malformedCookie = false } = {}) {
  const compiledModule = { exports: {} };
  const calls = { protected: 0, options: null };
  const imports = {
    "next/server": { NextRequest, NextResponse },
    "@/i18n/config": localeConfig,
    "@/lib/utils/env": {
      hasClerkEnv: () => configured,
      getClerkAuthorizedParties: () => ["https://eventzeka.com"],
      shouldFailClosedForAdminRoutes: () => true,
    },
    "@clerk/nextjs/server": {
      createRouteMatcher: (patterns) => (request) => patterns.some((pattern) => request.nextUrl.pathname.startsWith(pattern.replace("(.*)", ""))),
      clerkMiddleware: (handler, options) => {
        calls.options = options;
        return async (request) => {
          if (malformedCookie) throw new SyntaxError("Unexpected end of JSON input");
          const auth = Object.assign(async () => ({}), { protect: async () => { calls.protected += 1; } });
          return handler(auth, request);
        };
      },
    },
  };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected middleware dependency: ${name}`);
    return imports[name];
  }, compiledModule, compiledModule.exports);
  return { handle: compiledModule.exports.default, config: compiledModule.exports.config, calls };
}

for (const configured of [false, true]) {
  const { handle, config, calls } = loadMiddleware({ configured });
  assert.ok(config.matcher.some((pattern) => pattern.includes("_next")), "Public pages must enter locale validation.");
  assert.ok(config.matcher.includes("/admin/:path*"), "Operational pages retain protection even for dotted subpaths.");
  for (const page of ["sign-in", "sign-up", "events", "venues"]) {
    assert.ok(config.matcher.includes(`/${page}/:path*`), "Catch-all and dynamic public routes validate locale even for dotted segments.");
  }
  for (const prefix of ["en", "ru", "sr"]) {
    assert.ok(config.matcher.includes(`/${prefix}/:path*`), "Locale guards include dotted paths and cannot be skipped before a public rewrite.");
  }
  assert.ok(config.matcher.includes("/api/admin/:path*"));
  assert.ok(config.matcher.includes("/api/user/:path*"));
  for (const [path, locale] of [
    ["/", "sr"],
    ["/discover", "sr"],
    ["/sign-in/qa.callback", "sr"],
    ["/en", "en"],
    ["/ru/events/event_123", "ru"],
    ["/en/sign-in/verify", "en"],
  ]) {
    const response = await handle(new NextRequest(`https://eventzeka.com${path}?date=2026-11-07&q=abc`, {
      headers: { "x-eventzeka-locale": "ru", "accept-language": "ru", cookie: "locale=ru" },
    }), {});
    assert.equal(response.headers.get("x-middleware-request-x-eventzeka-locale"), locale, "URL must override a forged header, cookie and browser language.");
    assert.equal(response.headers.get("content-language"), localeConfig.LOCALE_LANGUAGE_TAGS[locale]);
    const destination = response.headers.get("x-middleware-rewrite");
    assert.equal(destination, null, "Middleware must not proxy into itself and reset the locale; the fixed public rewrite table resolves the page.");
  }
  const canonical = await handle(new NextRequest("https://eventzeka.com/sr/discover?date=2026-11-07"), {});
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.get("location"), "https://eventzeka.com/discover?date=2026-11-07");
  for (const denied of ["/ru/admin", "/en/api/admin/events", "/ru/api/user/library", "/sr/sso-callback", "/en/not-real"]) {
    const response = await handle(new NextRequest(`https://eventzeka.com${denied}`), {});
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-middleware-rewrite"), null);
  }
  const admin = await handle(new NextRequest("https://eventzeka.com/admin"), {});
  assert.equal(admin.status, configured ? 200 : 503);
  const adminApi = await handle(new NextRequest("https://eventzeka.com/api/admin/events"), {});
  assert.equal(adminApi.status, configured ? 200 : 503);
  if (configured) {
    assert.equal(calls.protected, 2, "Existing operational pages and APIs still require Clerk protection.");
    assert.deepEqual(calls.options, { authorizedParties: ["https://eventzeka.com"] });
  } else {
    assert.deepEqual(await adminApi.json(), { error: "Admin authentication is not configured." });
  }
}

const malformed = loadMiddleware({ configured: true, malformedCookie: true });
const recovery = await malformed.handle(new NextRequest("https://eventzeka.com/ru/saved?date=2026-11-07", {
  headers: { cookie: "__session=broken; keep=untouched" },
}), {});
const recoveryUrl = new URL(recovery.headers.get("location"));
assert.equal(recoveryUrl.pathname, "/ru/sign-in");
assert.equal(recoveryUrl.searchParams.get("redirect_url"), "/ru/saved?date=2026-11-07");
assert.match(recovery.headers.get("set-cookie"), /__session=/u);
assert.doesNotMatch(recovery.headers.get("set-cookie"), /keep=/u);
const invalidUserApi = await malformed.handle(new NextRequest("https://eventzeka.com/api/user/library"), {});
assert.equal(invalidUserApi.status, 401);
assert.deepEqual(await invalidUserApi.json(), { error: "Invalid authentication session." });

const redirects = await nextConfig.redirects();
const rewrites = await nextConfig.rewrites();
assert.deepEqual(rewrites.afterFiles, []);
assert.deepEqual(rewrites.fallback, []);
for (const locale of ["en", "ru"]) {
  assert.ok(rewrites.beforeFiles.some((route) => route.source === `/${locale}` && route.destination === "/"));
  for (const route of ["discover", "map", "saved", "you", "install", "venues/directory"]) {
    assert.ok(rewrites.beforeFiles.some((entry) => entry.source === `/${locale}/${route}` && entry.destination === `/${route}`));
  }
  assert.ok(rewrites.beforeFiles.some((route) => route.source === `/${locale}/events/:eventId` && route.destination === "/events/:eventId"));
  assert.equal(rewrites.beforeFiles.some((route) => route.source === `/${locale}/:path*`), false,
    "A broad rewrite could expose alternate operational or API paths.");
}
for (const locale of ["en", "ru"]) {
  for (const alias of ["calendar", "events"]) {
    assert.ok(redirects.some((route) => route.source === `/${locale}/${alias}` && route.destination === `/${locale}` && route.permanent));
  }
  assert.ok(redirects.some((route) => route.source === `/${locale}/venues` && route.destination === `/${locale}/map?view=calendar` && route.permanent));
}
assert.ok(readFileSync("i18n/server.ts", "utf8").startsWith('import "server-only";'));

console.log("Locale routing QA passed: URL-bound trusted headers, shared canonical routes, locale switching, legacy redirects, operational isolation, Clerk guards and localized cookie recovery.");
