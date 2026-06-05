import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
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

export default hasClerkConfig
  ? clerkMiddleware(async (auth, req) => {
      if (isAdminRoute(req)) {
        await auth.protect();
      }
    })
  : function middlewareWithoutAuth(req: NextRequest) {
      if (isAdminRoute(req) && shouldFailClosedForAdminRoutes()) {
        return adminAuthNotConfiguredResponse(req);
      }

      return NextResponse.next();
    };

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
