import { createOgImageHandler } from "@/lib/seo/og-image";

/** Historical image URL stays available without file-based metadata overrides. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createOgImageHandler({ fixedLocale: "sr" });
export const HEAD = GET;
