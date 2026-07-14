import { buildApplicationSecurityHeaders } from "./lib/security/headers.mjs";

/** @type {import("next").NextConfig} */
const CANONICAL_APP_ORIGIN = "https://events.ineedtofeedmyrabbit.com";
const VERCEL_PRODUCTION_HOST = "ig-event.vercel.app";
const convexImageRemotePattern = (() => {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_CONVEX_URL ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return {
      protocol: url.protocol.slice(0, -1),
      hostname: url.hostname,
      ...(url.port ? { port: url.port } : {}),
    };
  } catch {
    return null;
  }
})();
const applicationSecurityHeaders = buildApplicationSecurityHeaders({
  clerkOrigin: process.env.CLERK_JWT_ISSUER_DOMAIN,
  convexOrigin: process.env.NEXT_PUBLIC_CONVEX_URL,
  production: process.env.NODE_ENV === "production",
});

const nextConfig = {
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
        has: [{ type: "host", value: VERCEL_PRODUCTION_HOST }],
        destination: `${CANONICAL_APP_ORIGIN}/:path*`,
        permanent: true,
      },
      {
        source: "/map",
        destination: "/venues",
        permanent: false,
      },
      {
        source: "/calendar",
        destination: "/",
        permanent: false,
      },
      {
        source: "/events",
        destination: "/",
        permanent: false,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.apifyusercontent.com",
      },
      ...(convexImageRemotePattern ? [convexImageRemotePattern] : []),
    ],
  },
};

export default nextConfig;
