/**
 * AI execution is intentionally serialized. The underlying lease can report
 * either that it is "busy" or that it "could not be acquired"; both mean the
 * already-persisted post must wait, never be re-fetched or treated as a
 * provider failure.
 */
export function isTransientSavedPostProcessingError(value: string | undefined): boolean {
  return Boolean(value && /saved post processing is (busy|deferred)|openai provider execution lease (is busy|could not be acquired)/i.test(value));
}
