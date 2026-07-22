import { buildApplicationSecurityHeaders } from "./lib/security/headers.mjs";

/** @type {import("next").NextConfig} */
const CANONICAL_APP_ORIGIN = "https://eventzeka.com";
const WWW_APP_HOST = "www.eventzeka.com";
const LEGACY_APP_HOST = "events.ineedtofeedmyrabbit.com";
const VERCEL_PRODUCTION_HOST = "ig-event.vercel.app";
const applicationSecurityHeaders = buildApplicationSecurityHeaders({
  clerkOrigin: process.env.CLERK_JWT_ISSUER_DOMAIN,
  convexOrigin: process.env.NEXT_PUBLIC_CONVEX_URL,
  production: process.env.NODE_ENV === "production",
});

const nextConfig = {
  // Resolve route metadata before streaming for every user agent so dynamic
  // notFound() responses preserve real 404 status codes for crawlers and users.
  htmlLimitedBots: /.*/,
  // Limit static-generation workers so release and Docker builds stay within the
  // memory budget of the production VPS instead of stalling under swap pressure.
  experimental: {
    cpus: 1,
  },
  // Release checks and Docker builds run `npm run lint` and `npm run typecheck`
  // explicitly before `next build`. Skipping Next's duplicate internal checks
  // prevents production builds from hanging in the post-compile validation phase
  // while preserving the same lint/type gates in CI and image builds.
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack(config, { dev }) {
    if (!dev) {
      // The local filesystem cache can hang or time out during production builds.
      config.cache = false;
    }

    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: applicationSecurityHeaders,
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: WWW_APP_HOST }],
        destination: `${CANONICAL_APP_ORIGIN}/:path*`,
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: VERCEL_PRODUCTION_HOST }],
        destination: `${CANONICAL_APP_ORIGIN}/:path*`,
        permanent: true,
      },
      {
        source: "/sign-in/:path*",
        has: [{ type: "host", value: LEGACY_APP_HOST }],
        destination: `${CANONICAL_APP_ORIGIN}/sign-in/:path*`,
        permanent: true,
      },
      {
        source: "/sign-up/:path*",
        has: [{ type: "host", value: LEGACY_APP_HOST }],
        destination: `${CANONICAL_APP_ORIGIN}/sign-up/:path*`,
        permanent: true,
      },
      {
        source: "/map",
        destination: "/venues",
        permanent: true,
      },
      {
        source: "/calendar",
        destination: "/",
        permanent: true,
      },
      {
        source: "/events",
        destination: "/",
        permanent: true,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.apifyusercontent.com",
      },
    ],
  },
};

export default nextConfig;
