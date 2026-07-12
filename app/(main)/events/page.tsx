import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RedirectSearchParams = Record<string, string | string[] | undefined>;

type RedirectPageProps = {
  searchParams?: Promise<RedirectSearchParams>;
};

function buildEventsHref(searchParams?: RedirectSearchParams): string {
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

  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export default async function EventsRedirectPage({ searchParams }: RedirectPageProps) {
  redirect(buildEventsHref(await searchParams));
}
