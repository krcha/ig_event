import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import {
  getClerkAuthorizedParties,
  hasClerkEnv,
  shouldFailClosedForAdminRoutes,
} from "@/lib/utils/env";
import {
  getLocaleFromPath,
  localizeHref,
  LOCALE_HEADER,
  LOCALE_LANGUAGE_TAGS,
  resolveLocaleRequestPath,
} from "@/i18n/config";

const isAdminRoute = createRouteMatcher(["/admin(.*)", "/api/admin(.*)"]);
const isAdminApiRoute = createRouteMatcher(["/api/admin(.*)"]);
const isUserApiRoute = createRouteMatcher(["/api/user(.*)"]);
const hasClerkConfig = hasClerkEnv();
const clerkAuthorizedParties = getClerkAuthorizedParties();

function adminAuthNotConfiguredResponse(req: NextRequest): NextResponse {
  if (isAdminApiRoute(req)) {
    return NextResponse.json(
      { error: "Admin authentication is not configured." },
      { status: 503 },
    );
  }

  return new NextResponse("Admin authentication is not configured.", {
    status: 503,
  });
}

function isMalformedClerkCookieError(error: unknown): boolean {
  return error instanceof SyntaxError && /Unexpected end/.test(error.message);
}

function clearClerkCookies(response: NextResponse, req: NextRequest): NextResponse {
  for (const cookie of req.cookies.getAll()) {
    if (cookie.name.startsWith("__session") || cookie.name.startsWith("__client")) {
      response.cookies.delete(cookie.name);
    }
  }

  return response;
}

function malformedClerkCookieResponse(req: NextRequest): NextResponse {
  if (isAdminApiRoute(req) || isUserApiRoute(req)) {
    return clearClerkCookies(
      NextResponse.json({ error: "Invalid authentication session." }, { status: 401 }),
      req,
    );
  }

  const signInUrl = new URL(localizeHref("/sign-in", getLocaleFromPath(req.nextUrl.pathname)), req.url);
  signInUrl.searchParams.set("redirect_url", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return clearClerkCookies(NextResponse.redirect(signInUrl), req);
}

function localizedPageResponse(req: NextRequest): NextResponse {
  const resolution = resolveLocaleRequestPath(req.nextUrl.pathname);
  if (resolution.kind === "not_found") {
    return new NextResponse("Not found.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
  }
  if (resolution.kind === "redirect") {
    const destination = req.nextUrl.clone();
    destination.pathname = resolution.pathname;
    return NextResponse.redirect(destination, 308);
  }
  // Locale is URL-bound. Never trust an externally supplied locale header,
  // browser language or preference cookie for server-rendered page identity.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete(LOCALE_HEADER);
  requestHeaders.set(LOCALE_HEADER, resolution.locale);
  // The public-only beforeFiles rewrites in next.config route these URLs to
  // the existing pages. A middleware rewrite would proxy into middleware a
  // second time on the self-hosted server and lose the original URL locale.
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    response.headers.set("content-language", LOCALE_LANGUAGE_TAGS[resolution.locale]);
  }
  return response;
}

const clerkAdminMiddleware = clerkMiddleware(
  async (auth, req) => {
    if (isAdminRoute(req)) {
      await auth.protect();
    }
    return localizedPageResponse(req);
  },
  clerkAuthorizedParties ? { authorizedParties: clerkAuthorizedParties } : undefined,
);

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!hasClerkConfig) {
    if (isAdminRoute(req) && shouldFailClosedForAdminRoutes()) {
      return adminAuthNotConfiguredResponse(req);
    }

    return localizedPageResponse(req);
  }

  try {
    return await clerkAdminMiddleware(req, event);
  } catch (error) {
    if (isMalformedClerkCookieError(error)) {
      return malformedClerkCookieResponse(req);
    }

    throw error;
  }
}

export const config = {
  matcher: [
    "/((?!api|_next|fonts|images|.*\\..*).*)",
    "/en/:path*",
    "/ru/:path*",
    "/sr/:path*",
    "/sign-in/:path*",
    "/sign-up/:path*",
    "/events/:path*",
    "/venues/:path*",
    "/admin/:path*",
    "/api/admin/:path*",
    "/api/user/:path*",
  ],
};
