/**
 * AI execution is intentionally serialized. The underlying lease can report
 * either that it is "busy" or that it "could not be acquired"; both mean the
 * already-persisted post must wait, never be re-fetched or treated as a
 * provider failure.
 */
export function isTransientSavedPostProcessingError(value: unknown): boolean {
  // This value crosses several boundaries (the processing summary, thrown
  // route errors, and occasionally an Error wrapper). Match the stable
  // meaning rather than one exact sentence so an AI lease wait never becomes
  // a 503/restart just because an intermediate layer added context.
  const message = getErrorMessage(value);
  return /\bsaved post processing\b[\s\S]{0,160}\b(?:busy|deferred)\b|\bopenai provider execution lease\b[\s\S]{0,160}\b(?:is busy|could not be acquired)\b/i.test(
    message,
  );
}

export function isDurableSavedPostRevisionMismatch(value: unknown): boolean {
  return /saved-post source revision changed/i.test(getErrorMessage(value));
}

function getErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const cause = "cause" in value ? getErrorMessage(value.cause) : "";
    return cause ? `${value.name}: ${value.message}; caused by: ${cause}` : `${value.name}: ${value.message}`;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? "");
}
