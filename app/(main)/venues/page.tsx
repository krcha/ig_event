import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RedirectSearchParams = Record<string, string | string[] | undefined>;

type RedirectPageProps = {
  searchParams?: Promise<RedirectSearchParams>;
};

function buildMapHref(searchParams?: RedirectSearchParams): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else if (typeof value === "string") {
      params.set(key, value);
    }
  }

  // Bypass previously cached permanent /map -> /venues redirects.
  params.set("view", "calendar");
  return `/map?${params.toString()}`;
}

export default async function VenuesRedirectPage({ searchParams }: RedirectPageProps) {
  permanentRedirect(buildMapHref(await searchParams));
}
