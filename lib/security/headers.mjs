const DEFAULT_CLERK_ORIGIN = "https://clerk.events.ineedtofeedmyrabbit.com";
const CLOUDFLARE_CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";
const CLERK_IMAGE_ORIGIN = "https://img.clerk.com";
const CLERK_TELEMETRY_ORIGINS = [
  "https://clerk-telemetry.com",
  "https://*.clerk-telemetry.com",
];
const APIFY_IMAGE_ORIGIN = "https://images.apifyusercontent.com";

function normalizeHttpOrigin(value, fallback = null) {
  const candidate = value?.trim();
  if (!candidate) return fallback;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return fallback;
    }
    return url.origin;
  } catch {
    return fallback;
  }
}

function toWebSocketOrigin(origin) {
  if (!origin) return null;
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

function serializeDirectives(directives) {
  return directives
    .filter((directive) => directive.length > 0)
    .map((directive) => `${directive.join(" ")};`)
    .join(" ");
}

export function buildContentSecurityPolicy({
  clerkOrigin = DEFAULT_CLERK_ORIGIN,
  convexOrigin,
  production = true,
} = {}) {
  const normalizedClerkOrigin = normalizeHttpOrigin(clerkOrigin, DEFAULT_CLERK_ORIGIN);
  const normalizedConvexOrigin = normalizeHttpOrigin(convexOrigin);
  const convexWebSocketOrigin = toWebSocketOrigin(normalizedConvexOrigin);

  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(!production ? ["'unsafe-eval'"] : []),
    normalizedClerkOrigin,
    CLOUDFLARE_CHALLENGE_ORIGIN,
  ];
  const connectSources = [
    "'self'",
    normalizedClerkOrigin,
    normalizedConvexOrigin,
    convexWebSocketOrigin,
    ...CLERK_TELEMETRY_ORIGINS,
  ].filter(Boolean);

  return serializeDirectives([
    ["default-src", "'self'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["script-src", ...scriptSources],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", APIFY_IMAGE_ORIGIN, CLERK_IMAGE_ORIGIN],
    ["font-src", "'self'", "data:"],
    ["connect-src", ...connectSources],
    ["worker-src", "'self'", "blob:"],
    ["frame-src", "'self'", CLOUDFLARE_CHALLENGE_ORIGIN],
    ["media-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
    ...(production ? [["upgrade-insecure-requests"]] : []),
  ]);
}

export function buildApplicationSecurityHeaders(options = {}) {
  return [
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(options),
    },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "X-Frame-Options",
      value: "DENY",
    },
  ];
}

export const SECURITY_HEADER_OWNERSHIP = {
  application: [
    "Content-Security-Policy",
    "Permissions-Policy",
    "Referrer-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ],
  canonicalHttpsProxy: ["Strict-Transport-Security"],
};
