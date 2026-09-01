import { type IngestionVenueResolverSnapshotInput } from "@/lib/domain/venues/index";
import { buildLegacyOperationalVenueRecords, loadOperationalVenueResolverSnapshot } from "@/lib/pipeline/operational-venues";
import { buildCanonicalVenueAliasesByHandle, buildCanonicalVenueLocationsByHandle, buildCanonicalVenueNamesByHandle, type CanonicalVenueAliasesByHandle, normalizeHandle } from "@/lib/pipeline/venue-normalization";
import { ConvexHttpClient } from "convex/browser";
import type { HandlePage, IngestionStep, IngestionVenueContext, InstagramIngestionSourceContext } from "@/lib/pipeline/ingestion/contracts";
import { getInstagramIngestionContextsByHandlesQuery, listActiveInstagramSourceHandlesPageQuery, listLegacyVenueHandlesPageQuery } from "@/lib/pipeline/ingestion/convex-bindings";
import { getErrorMessage, logError, withServiceSecret } from "@/lib/pipeline/ingestion/runtime";
import { normalizeString } from "@/lib/pipeline/ingestion/values";

const ACTIVE_SOURCE_PAGE_SIZE = 200;
const MAX_ACTIVE_SOURCE_PAGES = 10_000;


export async function loadCanonicalVenueMapsByHandle(
  client: ConvexHttpClient,
  serviceSecret: string,
): Promise<{
  canonicalVenueNamesByHandle: Record<string, string>;
  canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle;
  canonicalVenueLocationsByHandle: Record<string, string>;
  venueResolverSnapshot: IngestionVenueResolverSnapshotInput;
}> {
  const venueResolverSnapshot = await loadOperationalVenueResolverSnapshot({
    client,
    serviceSecret,
  });
  const venues = buildLegacyOperationalVenueRecords(venueResolverSnapshot);
  return {
    canonicalVenueNamesByHandle: buildCanonicalVenueNamesByHandle(venues),
    canonicalVenueAliasesByHandle: buildCanonicalVenueAliasesByHandle(venues),
    canonicalVenueLocationsByHandle: buildCanonicalVenueLocationsByHandle(venues),
    venueResolverSnapshot,
  };
}

export function buildConfiguredVenueNamesByHandle(
  canonicalVenueNamesByHandle: Record<string, string>,
  _legacyVenueNameOverridesByHandle: Record<string, string> = {},
  _sourceRolesByHandle: Record<string, "venue" | "promoter" | "unknown"> = {},
): Record<string, string> {
  // The second argument remains only for compatibility with isolated parser
  // fixtures. Tracked CSV overrides are migration/operator input and must not
  // outrank the durable venue + venueIdentity snapshot in steady-state
  // ingestion. A configured source handle therefore means a durable mapping.
  return { ...canonicalVenueNamesByHandle };
}

export async function loadAllActiveInstagramSourceHandles(
  client: ConvexHttpClient,
  serviceSecret: string,
): Promise<string[]> {
  const handles = new Set<string>();
  const partitions = [
    listLegacyVenueHandlesPageQuery,
    listActiveInstagramSourceHandlesPageQuery,
  ];

  for (const query of partitions) {
    let cursor: string | null = null;
    let completed = false;
    for (let pageIndex = 0; pageIndex < MAX_ACTIVE_SOURCE_PAGES; pageIndex += 1) {
      const result = (await client.query(
        query,
        withServiceSecret(
          { paginationOpts: { numItems: ACTIVE_SOURCE_PAGE_SIZE, cursor } },
          serviceSecret,
        ),
      )) as HandlePage;
      for (const rawHandle of result.page) {
        const handle = normalizeHandle(rawHandle);
        if (handle) handles.add(handle);
      }
      if (result.isDone) {
        completed = true;
        break;
      }
      if (!result.continueCursor || result.continueCursor === cursor) {
        throw new Error("Active Instagram source pagination did not advance.");
      }
      cursor = result.continueCursor;
    }
    if (!completed) {
      throw new Error(
        `Active Instagram source pagination exceeded ${MAX_ACTIVE_SOURCE_PAGES} pages.`,
      );
    }
  }

  return [...handles].sort((left, right) => left.localeCompare(right));
}

export async function loadInstagramIngestionContextsForHandles(
  client: ConvexHttpClient,
  serviceSecret: string,
  handles: string[],
): Promise<InstagramIngestionSourceContext[]> {
  const normalizedHandles = [...new Set(handles.map(normalizeHandle).filter(Boolean))];
  const contexts: InstagramIngestionSourceContext[] = [];
  for (let index = 0; index < normalizedHandles.length; index += 25) {
    const chunk = normalizedHandles.slice(index, index + 25);
    const result = (await client.query(
      getInstagramIngestionContextsByHandlesQuery,
      withServiceSecret({ handles: chunk }, serviceSecret),
    )) as InstagramIngestionSourceContext[];
    contexts.push(...result);
  }
  return contexts;
}

export async function loadIngestionVenueContextForHandles(
  client: ConvexHttpClient,
  serviceSecret: string,
  handles: string[],
): Promise<IngestionVenueContext> {
  const requestedHandles = new Set(handles.map(normalizeHandle).filter(Boolean));
  let contexts: InstagramIngestionSourceContext[] = [];
  let canonicalVenueDirectory: Awaited<
    ReturnType<typeof loadCanonicalVenueMapsByHandle>
  >;
  try {
    contexts = await loadInstagramIngestionContextsForHandles(
      client,
      serviceSecret,
      [...requestedHandles],
    );
  } catch (error) {
    logError("ingestion.sources.context_load_failed", {
      step: "normalize_posts" satisfies IngestionStep,
      handles: [...requestedHandles],
      error: getErrorMessage(error),
    });
    throw error;
  }
  try {
    // Source roles stay handle-targeted, while venue text normalization needs
    // the lightweight global name/alias directory so promoter posts can name
    // a different venue by one of its learned aliases.
    canonicalVenueDirectory = await loadCanonicalVenueMapsByHandle(
      client,
      serviceSecret,
    );
  } catch (error) {
    logError("ingestion.venues.canonical_directory_load_failed", {
      step: "normalize_posts" satisfies IngestionStep,
      handles: [...requestedHandles],
      error: getErrorMessage(error),
    });
    throw error;
  }
  const {
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    canonicalVenueLocationsByHandle,
    venueResolverSnapshot,
  } = canonicalVenueDirectory;
  const sourceRolesByHandle = Object.fromEntries(
    contexts.map((context) => [normalizeHandle(context.handle), context.role]),
  );
  const sourceDisplayNamesByHandle = Object.fromEntries(
    contexts.flatMap((context) => {
      const handle = normalizeHandle(context.handle);
      const displayName = normalizeString(context.observedDisplayName);
      return handle && displayName ? [[handle, displayName] as const] : [];
    }),
  );
  return {
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    canonicalVenueLocationsByHandle,
    venueResolverSnapshot,
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle: buildConfiguredVenueNamesByHandle(
      canonicalVenueNamesByHandle,
      {},
    ),
    sourceDisplayNamesByHandle,
    sourceRolesByHandle,
  };
}

export async function loadIngestionVenueContext(
  client: ConvexHttpClient,
  serviceSecret: string,
): Promise<IngestionVenueContext> {
  let canonicalVenueNamesByHandle: Record<string, string> = {};
  let canonicalVenueAliasesByHandle: CanonicalVenueAliasesByHandle = {};
  let canonicalVenueLocationsByHandle: Record<string, string> = {};
  let venueResolverSnapshot: IngestionVenueResolverSnapshotInput = {
    identities: [],
    venues: [],
  };
  let configuredVenueNamesByHandle: Record<string, string> = {};
  let sourceDisplayNamesByHandle: Record<string, string> = {};
  let sourceRolesByHandle: Record<string, "venue" | "promoter" | "unknown"> = {};

  try {
    ({
      canonicalVenueNamesByHandle,
      canonicalVenueAliasesByHandle,
      canonicalVenueLocationsByHandle,
      venueResolverSnapshot,
    } =
      await loadCanonicalVenueMapsByHandle(
        client,
        serviceSecret,
      ));
    try {
      const handles = await loadAllActiveInstagramSourceHandles(client, serviceSecret);
      const sources = await loadInstagramIngestionContextsForHandles(
        client,
        serviceSecret,
        handles,
      );
      sourceRolesByHandle = Object.fromEntries(
        sources
          .map((source) => [normalizeHandle(source.handle), source.role] as const)
          .filter(
            (entry): entry is readonly [string, "venue" | "promoter" | "unknown"] =>
              Boolean(entry[0] && entry[1]),
          ),
      );
      sourceDisplayNamesByHandle = Object.fromEntries(
        sources.flatMap((source) => {
          const handle = normalizeHandle(source.handle);
          const displayName = normalizeString(source.observedDisplayName);
          return handle && displayName ? [[handle, displayName] as const] : [];
        }),
      );
    } catch (error) {
      logError("ingestion.sources.load_failed", {
        step: "normalize_posts" satisfies IngestionStep,
        error: getErrorMessage(error),
      });
    }
    configuredVenueNamesByHandle = buildConfiguredVenueNamesByHandle(
      canonicalVenueNamesByHandle,
      {},
    );
  } catch (error) {
    logError("ingestion.venues.load_failed", {
      step: "normalize_posts" satisfies IngestionStep,
      error: getErrorMessage(error),
    });
  }

  return {
    canonicalVenueNamesByHandle,
    canonicalVenueAliasesByHandle,
    canonicalVenueLocationsByHandle,
    venueResolverSnapshot,
    // Retained in the compatibility DTO until old parser callers retire. The
    // steady-state loader deliberately supplies no migration-only CSV facts.
    venueNameOverridesByHandle: {},
    configuredVenueNamesByHandle,
    sourceDisplayNamesByHandle,
    sourceRolesByHandle,
  };
}
