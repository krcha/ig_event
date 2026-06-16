/** @type {import("next").NextConfig} */
const nextConfig = {
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
