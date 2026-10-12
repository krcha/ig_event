import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/lib/seo/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // Event posters are public assets used in pages and structured data.
        allow: ["/", "/api/discover/images/"],
        disallow: [
          "/admin",
          "/admin/",
          "/api/",
          "/sso-callback",
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
