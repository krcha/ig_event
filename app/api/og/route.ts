import { createOgImageHandler } from "@/lib/seo/og-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export const GET = createOgImageHandler();
export const HEAD = GET;
