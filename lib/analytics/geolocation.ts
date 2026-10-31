import "server-only";

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { Reader, type CountryResponse } from "mmdb-lib";

type CountryRecord = CountryResponse & { country_code?: string };
let readerPath = "";
let readerPromise: Promise<Reader<CountryRecord> | null> | null = null;

function countryCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) && !["XX", "ZZ"].includes(code) ? code : null;
}

export function getTrustedVisitorIp(headers: Headers, trusted: boolean): string | null {
  if (!trusted) return null;
  // The private listener is reached directly through Traefik, which appends the
  // socket peer to the right of X-Forwarded-For. Client-supplied left entries
  // cannot override it. Review this boundary before adding another proxy/CDN.
  const ip = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return ip && isIP(ip) ? ip : null;
}

export async function getVisitorCountry(headers: Headers, env: Record<string, string | undefined> = process.env): Promise<string> {
  const header = env.VERCEL === "1" ? "x-vercel-ip-country" : env.ANALYTICS_COUNTRY_HEADER?.trim();
  const edgeCountry = header ? countryCode(headers.get(header)) : null;
  if (edgeCountry) return edgeCountry;

  const path = env.ANALYTICS_COUNTRY_DB_PATH?.trim();
  const ip = getTrustedVisitorIp(headers, env.ANALYTICS_TRUST_PROXY === "true");
  if (!path || !ip) return "Unknown";
  try {
    if (!readerPromise || readerPath !== path) {
      readerPath = path;
      readerPromise = readFile(path).then((data) => new Reader<CountryRecord>(data)).catch(() => null);
    }
    const reader = await readerPromise;
    const record = reader?.get(ip);
    return countryCode(record?.country_code) || countryCode(record?.country?.iso_code) || countryCode(record?.registered_country?.iso_code) || "Unknown";
  } catch {
    // Never retain or log the lookup IP. Geography failure cannot lose a view.
    return "Unknown";
  }
}
