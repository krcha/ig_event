/** @type {import("next").NextConfig} */
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
  async redirects() {
    return [
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
        hostname: "**.cdninstagram.com",
      },
      {
        protocol: "https",
        hostname: "**.fbcdn.net",
      },
      {
        protocol: "https",
        hostname: "images.apifyusercontent.com",
      },
    ],
  },
};

export default nextConfig;
