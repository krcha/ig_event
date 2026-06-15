import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { hasClerkEnv, shouldFailClosedForAdminRoutes } from "@/lib/utils/env";

const isAdminRoute = createRouteMatcher(["/admin(.*)", "/api/admin(.*)"]);
const isAdminApiRoute = createRouteMatcher(["/api/admin(.*)"]);
const hasClerkConfig = hasClerkEnv();

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
  if (isAdminApiRoute(req)) {
    return clearClerkCookies(
      NextResponse.json({ error: "Invalid authentication session." }, { status: 401 }),
      req,
    );
  }

  const signInUrl = new URL("/sign-in", req.url);
  signInUrl.searchParams.set("redirect_url", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return clearClerkCookies(NextResponse.redirect(signInUrl), req);
}

const clerkAdminMiddleware = clerkMiddleware(async (auth, req) => {
  if (isAdminRoute(req)) {
    await auth.protect();
  }
});

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!hasClerkConfig) {
    if (isAdminRoute(req) && shouldFailClosedForAdminRoutes()) {
      return adminAuthNotConfiguredResponse(req);
    }

    return NextResponse.next();
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
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
