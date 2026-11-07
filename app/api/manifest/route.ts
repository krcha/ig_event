import manifest from "@/app/manifest";
import { isLocale, LOCALE_LANGUAGE_TAGS, localizeHref } from "@/i18n/config";
import { SITE_COPY } from "@/lib/i18n/seo";

export function GET(request: Request) {
  const candidate = new URL(request.url).searchParams.get("locale");
  if (candidate !== null && !isLocale(candidate)) return new Response("Invalid locale.", { status: 400 });
  const locale = isLocale(candidate) ? candidate : "sr";
  return Response.json({ ...manifest(), lang: LOCALE_LANGUAGE_TAGS[locale], description: SITE_COPY[locale].description,
    id: "/", scope: "/", start_url: localizeHref("/", locale) }, {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
  });
}
