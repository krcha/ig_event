import { DomainError } from "../../lib/domain/errors";
import { canonicalizeSourceUrl } from "../../lib/domain/source-url";

/**
 * Write-side source identity is valid only when the central provider
 * canonicalizer accepts it. Compatibility reads may retain older lookup
 * fallbacks, but mutations must never turn malformed input into identity.
 */
export function requireCanonicalInstagramPostUrl(
  value: string | null | undefined,
  context: string,
): string {
  const canonical = canonicalizeSourceUrl("instagram", value);
  if (!canonical.ok) {
    throw new DomainError(
      "SOURCE_URL_INVALID",
      `${context} requires a canonical Instagram post URL.`,
      {
        cause: canonical.error,
        details: { context },
      },
    );
  }
  return canonical.value.canonicalUrl;
}
