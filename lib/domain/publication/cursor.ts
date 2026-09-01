import { DomainError } from "../errors";

export type PublicationCursorMode = "compatibility" | "materialized";

const PUBLICATION_CURSOR_PREFIX = "event-zeka-publication-cursor-v1:";

function resetRequired(
  cursorMode: PublicationCursorMode | "legacy",
  currentMode: PublicationCursorMode,
): never {
  throw new DomainError(
    "RECONCILIATION_CONFLICT",
    "Publication read mode changed during pagination; restart from the first page.",
    {
      details: {
        code: "E_PUBLICATION_CURSOR_RESET_REQUIRED",
        currentMode,
        cursorMode,
        resetRequired: true,
      },
    },
  );
}
/**
 * Convex cursors are index-specific. This envelope prevents a cursor emitted
 * by the materialized publication index from ever being passed to the legacy
 * status index (or vice versa) after rollback/topology fallback.
 */
export function encodePublicationCursor(
  rawCursor: string,
  mode: PublicationCursorMode,
): string {
  if (!rawCursor) return "";
  return `${PUBLICATION_CURSOR_PREFIX}${mode}:${encodeURIComponent(rawCursor)}`;
}

export function decodePublicationCursor(
  cursor: string | null | undefined,
  currentMode: PublicationCursorMode,
): string | null {
  if (!cursor) return null;
  if (!cursor.startsWith(PUBLICATION_CURSOR_PREFIX)) {
    // Cursors created before this envelope existed can only have come from the
    // compatibility/status index. They remain usable until the first cutover.
    if (currentMode === "compatibility") return cursor;
    return resetRequired("legacy", currentMode);
  }
  const encoded = cursor.slice(PUBLICATION_CURSOR_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator < 0) return resetRequired("legacy", currentMode);
  const cursorMode = encoded.slice(0, separator);
  if (cursorMode !== "compatibility" && cursorMode !== "materialized") {
    return resetRequired("legacy", currentMode);
  }
  if (cursorMode !== currentMode) return resetRequired(cursorMode, currentMode);
  try {
    const rawCursor = decodeURIComponent(encoded.slice(separator + 1));
    if (!rawCursor) return resetRequired(cursorMode, currentMode);
    return rawCursor;
  } catch {
    return resetRequired(cursorMode, currentMode);
  }
}
