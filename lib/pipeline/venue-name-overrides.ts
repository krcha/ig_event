import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { normalizeHandle } from "@/lib/pipeline/venue-normalization";

const VENUE_NAME_OVERRIDES_CSV_PATH = path.join(
  process.cwd(),
  "data",
  "venue-name-overrides.csv",
);

type CsvOverrideRow = {
  ig_handle?: string;
  venue_name?: string;
};

function parseVenueNameOverrides(csvText: string): Record<string, string> {
  const rows = parse(csvText, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvOverrideRow[];

  const overrides: Record<string, string> = {};
  for (const row of rows) {
    const handle = normalizeHandle(row.ig_handle ?? "");
    const venueName = (row.venue_name ?? "").trim();
    if (!handle || !venueName) {
      continue;
    }
    overrides[handle] = venueName;
  }

  return overrides;
}

async function readVenueNameOverrides(): Promise<Record<string, string>> {
  try {
    const csvText = await readFile(VENUE_NAME_OVERRIDES_CSV_PATH, "utf8");
    return parseVenueNameOverrides(csvText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function loadVenueNameOverridesByHandle(): Promise<Record<string, string>> {
  return readVenueNameOverrides();
}

export async function listVenueNameOverrideHandles(): Promise<string[]> {
  const overrides = await loadVenueNameOverridesByHandle();
  return Object.keys(overrides).sort((left, right) => left.localeCompare(right));
}
